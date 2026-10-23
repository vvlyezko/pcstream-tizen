'use strict';
/* Интерфейс PC Stream: выбор источника, настройки, запуск трансляции, звук. */

const $ = (id) => document.getElementById(id);

const DEFAULTS = { res: 0, fps: 60, bitrate: 20, cursor: true, audio: true, muteLocal: false };
let settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('pcs.settings') || '{}'));
let kind = localStorage.getItem('pcs.kind') || 'screen';
let sources = [];
let selectedId = localStorage.getItem('pcs.source') || '';
let state = 'idle';
let audio = null;

function save() {
    localStorage.setItem('pcs.settings', JSON.stringify(settings));
    localStorage.setItem('pcs.kind', kind);
    localStorage.setItem('pcs.source', selectedId);
}

function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

/* ---------- Источники ---------- */

// Картинки миниатюр — blob-ссылки, старые явно освобождаются (иначе память копится)
const blobUrls = { thumb: new Map(), icon: new Map() };

function blobUrl(kind, id, bytes, type) {
    const map = blobUrls[kind];
    if (kind === 'icon' && map.has(id)) return map.get(id); // иконка не меняется
    const old = map.get(id);
    const url = bytes ? URL.createObjectURL(new Blob([bytes], { type })) : '';
    if (url) map.set(id, url); else map.delete(id);
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000); // после того как DOM переключился
    return url;
}

function releaseGone(ids) {
    ['thumb', 'icon'].forEach((kind) => {
        blobUrls[kind].forEach((url, id) => {
            if (!ids.has(id)) { URL.revokeObjectURL(url); blobUrls[kind].delete(id); }
        });
    });
}

function selected() { return sources.find((s) => s.id === selectedId) || null; }

function renderSources() {
    const grid = $('grid');
    const list = sources.filter((s) => s.kind === kind);
    grid.innerHTML = '';
    if (!list.length) {
        grid.innerHTML = '<div class="empty">' + (kind === 'window' ? 'Нет открытых окон' : 'Экраны не найдены') + '</div>';
    }
    list.forEach((s) => {
        const el = document.createElement('div');
        el.className = 'src' + (s.id === selectedId ? ' selected' : '') + (s.minimized ? ' minimized' : '');
        el.dataset.id = s.id;
        el.innerHTML = '<div class="src-thumb"></div><div class="src-name">' + (s.iconUrl ? '<img alt="">' : '') + '<span></span></div>';
        el.querySelector('.src-thumb').style.backgroundImage = s.thumbUrl ? 'url("' + s.thumbUrl + '")' : '';
        if (s.iconUrl) el.querySelector('img').src = s.iconUrl;
        el.querySelector('span').textContent = s.name;
        if (s.minimized) el.querySelector('.src-thumb').setAttribute('data-note', 'Окно свёрнуто');
        el.onclick = () => select(s.id);
        el.ondblclick = () => { select(s.id); if (state !== 'streaming') start(); };
        grid.appendChild(el);
    });
    renderPreview();
}

function select(id) {
    selectedId = id;
    save();
    renderSources();
    // смена источника на лету
    if (state === 'streaming' || state === 'starting') start();
}

function renderPreview() {
    const s = selected();
    $('preview').style.backgroundImage = s && s.thumbUrl ? 'url("' + s.thumbUrl + '")' : '';
    $('preview').innerHTML = s ? '' : '<div class="preview-empty">Выберите экран или окно</div>';
    $('previewName').textContent = s ? s.name : '—';
    $('startBtn').disabled = !s && state !== 'streaming';
}

let lastRefresh = 0;

async function refresh() {
    lastRefresh = Date.now();
    let list;
    try {
        list = await window.pcs.sources();
    } catch (e) { return; }
    const ids = new Set();
    list.forEach((s) => {
        ids.add(s.id);
        s.thumbUrl = blobUrl('thumb', s.id, s.thumb, 'image/jpeg');
        s.iconUrl = blobUrl('icon', s.id, s.icon, 'image/png');
        delete s.thumb; delete s.icon;
    });
    releaseGone(ids);
    sources = list;
    if (!selected()) {
        const first = sources.find((s) => s.kind === kind) || sources[0];
        selectedId = first ? first.id : '';
    }
    renderSources();
    requestThumbs();
}

// Миниатюры делает FFmpeg на ПК по одному кадру; во время трансляции не трогаем
function requestThumbs() {
    if (state === 'streaming' || state === 'starting') return;
    window.pcs.thumbs(sources.filter((s) => s.kind === kind).map((s) => s.id));
}

function onThumb(t) {
    const s = sources.find((x) => x.id === t.id);
    if (!s) return;
    s.thumbUrl = blobUrl('thumb', s.id, t.jpeg, 'image/jpeg');
    const card = document.querySelector('.src[data-id="' + CSS.escape(s.id) + '"] .src-thumb');
    if (card) card.style.backgroundImage = 'url("' + s.thumbUrl + '")';
    if (s.id === selectedId) renderPreview();
}

/* ---------- Настройки ---------- */

function renderSettings() {
    document.querySelectorAll('.seg').forEach((seg) => {
        const key = seg.dataset.key;
        seg.querySelectorAll('button').forEach((b) => {
            b.classList.toggle('on', +b.dataset.v === settings[key]);
            b.onclick = () => { settings[key] = +b.dataset.v; save(); renderSettings(); restartIfLive(); };
        });
    });
    document.querySelectorAll('.toggle input').forEach((inp) => {
        const key = inp.dataset.key;
        inp.checked = !!settings[key];
        inp.disabled = key === 'muteLocal' && !settings.audio;
        inp.onchange = () => { settings[key] = inp.checked; save(); renderSettings(); restartIfLive(); };
    });
}

function restartIfLive() { if (state === 'streaming') start(); }

/* ---------- Трансляция ---------- */

async function startAudio() {
    stopAudio();
    if (!settings.audio) return;
    try {
        // Без обработки «для звонков»: иначе Chromium сводит звук в моно и включает эхо-/шумоподавление
        // и автоусиление — звук плавал по громкости и звучал с искажениями, «как с эхом».
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }
        });
        stream.getVideoTracks().forEach((t) => t.stop()); // нужна только звуковая дорожка
        const tracks = stream.getAudioTracks();
        if (!tracks.length) throw new Error('нет звуковой дорожки');
        const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        await ctx.audioWorklet.addModule('pcm-worklet.js');
        const src = ctx.createMediaStreamSource(new MediaStream(tracks));
        const tap = new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        const mute = ctx.createGain();
        mute.gain.value = 0;
        src.connect(tap);
        tap.connect(mute).connect(ctx.destination); // держит граф активным, на выходе тишина
        // Если на выходе AudioContext долго чистая тишина, Chromium (SilentSinkSuspender) отключает
        // настоящий аудиовыход и тикает таймером — в фоне он отстаёт, и терялась треть звука.
        // Неслышимое постоянное смещение не даёт выходу считаться «тихим».
        const keepAlive = ctx.createConstantSource();
        keepAlive.offset.value = 1e-6;
        keepAlive.connect(ctx.destination);
        keepAlive.start();
        tap.port.onmessage = (e) => window.pcs.audio(e.data);
        audio = { ctx, stream, tracks };
    } catch (e) {
        toast('Не удалось захватить звук: ' + e.message);
    }
}

function stopAudio() {
    if (!audio) return;
    audio.tracks.forEach((t) => t.stop());
    audio.ctx.close();
    audio = null;
}

async function start() {
    const s = selected();
    if (!s) return;
    await window.pcs.start({
        kind: s.kind, hwnd: s.hwnd, output: s.output, label: s.kind === 'screen' ? 'Весь экран' : s.name,
        srcW: s.w, srcH: s.h, res: settings.res,
        fps: settings.fps, bitrate: settings.bitrate, cursor: settings.cursor,
        audio: settings.audio, muteLocal: settings.audio && settings.muteLocal
    });
    startAudio();
}

async function stop() {
    stopAudio();
    await window.pcs.stop();
}

function setStatus(st) {
    state = st.state;
    const pill = $('statusPill');
    pill.className = 'pill ' + state;
    const btn = $('startBtn');
    const live = state === 'streaming' || state === 'starting';
    btn.classList.toggle('stop', live);
    btn.querySelector('span').textContent = live ? 'Остановить' : 'Начать трансляцию';
    btn.querySelector('svg').innerHTML = live ? '<rect x="6" y="6" width="12" height="12" rx="2" class="fill"/>' : '<path d="M8 5.5l11 6.5-11 6.5z" class="fill"/>';
    btn.disabled = !live && !selected();
    $('statusText').textContent = {
        idle: 'Готов к трансляции', starting: 'Запуск…', streaming: 'Идёт трансляция', error: 'Ошибка'
    }[state] || state;
    if (state === 'streaming' && st.meta) $('stRes').textContent = st.meta.width + '×' + st.meta.height;
    if (!live) { $('stFps').textContent = '—'; $('stMbps').textContent = '—'; $('stRes').textContent = '—'; stopAudio(); }
    if (state === 'error') toast(st.message || 'Ошибка трансляции');
    else if (st.message) toast(st.message);
}

/* ---------- Сеть ---------- */

const ICON_WIRE = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const ICON_WIFI = '<svg viewBox="0 0 24 24"><path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" class="fill"/></svg>';

async function renderNet() {
    const n = await window.pcs.net();
    const list = $('netList');
    list.innerHTML = '';
    if (!n.interfaces.length) list.innerHTML = '<div class="muted">Нет подключения к сети</div>';
    n.interfaces.forEach((i) => {
        const el = document.createElement('div');
        el.className = 'net-item';
        el.innerHTML = (i.wired ? ICON_WIRE : ICON_WIFI) + '<b></b><span></span>';
        el.querySelector('b').textContent = i.address + ':' + n.port;
        el.querySelector('span').textContent = i.wired ? 'кабель' : 'Wi‑Fi';
        list.appendChild(el);
    });
}

function renderClients(list) {
    const box = $('clientList');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="muted">Нет подключений. Откройте PC Stream на телевизоре.</div>'; return; }
    list.forEach((c) => {
        const el = document.createElement('div');
        el.className = 'client';
        el.innerHTML = '<b></b><span></span>';
        el.querySelector('b').textContent = c.name;
        el.querySelector('span').textContent = c.addr;
        box.appendChild(el);
    });
}

/* ---------- Запуск ---------- */

document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.kind === kind);
    t.onclick = () => {
        kind = t.dataset.kind;
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
        save();
        renderSources();
        requestThumbs();
    };
});
$('refreshBtn').onclick = refresh;
$('startBtn').onclick = () => (state === 'streaming' || state === 'starting' ? stop() : start());

window.pcs.on('status', setStatus);
window.pcs.on('stats', (s) => {
    $('stFps').textContent = s.fps;
    $('stMbps').textContent = s.mbps.toFixed(1);
});
window.pcs.on('clients', renderClients);
window.pcs.on('thumb', onThumb);

renderSettings();
refresh();
renderNet();
// Миниатюры обновляем, только когда окно на экране и в фокусе и трансляция не идёт:
// каждое обновление — это захват всех открытых окон системой
function canRefresh() {
    return state !== 'streaming' && state !== 'starting' && document.visibilityState === 'visible' && document.hasFocus();
}
setInterval(() => { if (canRefresh()) refresh(); }, 12000);
window.addEventListener('focus', () => { if (state !== 'streaming' && Date.now() - lastRefresh > 3000) refresh(); });
setInterval(renderNet, 15000);
