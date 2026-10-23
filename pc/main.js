'use strict';
/* PC Stream — сервер трансляции экрана ПК на телевизор Samsung (Tizen). */

const { app, BrowserWindow, ipcMain, session, dialog, nativeTheme } = require('electron');
const path = require('path');
const os = require('os');
const { StreamServer, interfaces, PORT } = require('./src/server');
const { Capture } = require('./src/capture');
const sources = require('./src/sources');

// Звук захватывается в окне: в свёрнутом/перекрытом окне Chromium замедляет его обработку
// (терялась ~треть звука). Отключаем фоновые ограничения для скрытых окон.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-media-suspend');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');

let win = null;
let server = null;
let capture = null;
let current = null;           // параметры текущей трансляции
let audioMode = 'loopback';   // 'loopbackWithMute' — заглушить звук на ПК
let statsTimer = null;
let retryTimer = null;
let restarts = 0;            // подряд перезапусков после потери захвата
// Windows отбирает Desktop Duplication при смене режима экрана (HDR, полноэкранная игра,
// смена разрешения, UAC) — ffmpeg завершается с DXGI_ERROR_ACCESS_LOST; просто перезапускаем
const LOST = /887a0026|887a0001|887a0022|ACCESS_LOST|AcquireNextFrame|DuplicateOutput/i;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function send(channel, data) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function createWindow() {
    nativeTheme.themeSource = 'dark';
    win = new BrowserWindow({
        width: 1240, height: 820, minWidth: 1000, minHeight: 680,
        title: 'PC Stream',
        icon: path.join(__dirname, 'renderer', 'icon.png'),
        backgroundColor: '#00000000',
        backgroundMaterial: 'acrylic',          // стекло Windows 11
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: '#e8ecf5', height: 44 },
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false        // звук должен идти и в свёрнутом окне
        }
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.on('closed', () => { win = null; });
}

/* ---------- Источники ---------- */

// Список окон — bin/winlist.exe, миниатюры — FFmpeg (см. src/sources.js).
// desktopCapturer здесь не используем: с миниатюрами окон он течёт памятью.
let lastList = [];
async function listSources() {
    lastList = await sources.list();
    return lastList;
}

/* ---------- Трансляция ---------- */

function stopCapture(reason) {
    clearTimeout(retryTimer);
    if (capture) { const c = capture; capture = null; c.stop(); }
    current = null;
    clearInterval(statsTimer);
    if (server && server.streaming) server.end(reason);
    send('status', { state: 'idle' });
}

function startCapture(opts) {
    stopCapture('switch');
    current = opts;
    audioMode = opts.muteLocal ? 'loopbackWithMute' : 'loopback';
    restarts = 0;
    runCapture(opts);
}

function runCapture(opts) {
    const cap = new Capture(opts);
    capture = cap;
    cap.on('init', (init, meta) => {
        if (capture !== cap) return;
        restarts = 0;
        meta.audio = !!opts.audio;
        server.begin(meta, init);
        send('status', { state: 'streaming', meta });
    });
    cap.on('fragment', (f) => { if (capture === cap) server.video(f); });
    cap.on('exit', (code, log) => {
        if (capture !== cap) return;
        capture = null;
        if (opts.kind !== 'window' && LOST.test(log) && restarts < 15) {
            restarts++;
            send('status', { state: 'starting', message: 'Режим экрана сменился — перезапускаю захват…' });
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => { if (current === opts && !capture) runCapture(opts); }, 700);
            return;
        }
        server.end('error');
        clearInterval(statsTimer);
        send('status', { state: 'error', message: explain(log, code) });
    });
    cap.on('error', (e) => { if (capture === cap) send('status', { state: 'error', message: e.message }); });
    cap.start();
    send('status', { state: 'starting' });

    let last = { frames: 0, bytes: 0, dropped: 0 };
    server.stats = { frames: 0, bytes: 0, dropped: 0 };
    clearInterval(statsTimer);
    statsTimer = setInterval(() => {
        const s = server.stats;
        send('stats', {
            fps: s.frames - last.frames,
            mbps: ((s.bytes - last.bytes) * 8 / 1e6),
            dropped: s.dropped - last.dropped
        });
        last = { frames: s.frames, bytes: s.bytes, dropped: s.dropped };
    }, 1000);
}

function explain(log, code) {
    if (/hwnd|window.*not found|Invalid window/i.test(log)) return 'Окно закрыто или недоступно для захвата';
    if (/nvenc|NVENC|CUDA/i.test(log)) return 'Ошибка видеокодера NVIDIA. Обновите драйвер видеокарты.';
    if (/DuplicateOutput|ddagrab/i.test(log)) return 'Не удалось захватить экран (возможно, открыт защищённый контент)';
    const line = (log || '').split(/\r?\n/).filter(Boolean).pop();
    return 'Захват остановился' + (line ? ': ' + line : ' (код ' + code + ')');
}

/* ---------- IPC ---------- */

ipcMain.handle('sources', () => listSources());
// миниатюры для перечисленных id приходят по мере готовности событием 'thumb'
ipcMain.handle('thumbs', (e, ids) => {
    const want = new Set(ids || []);
    sources.refreshThumbs(lastList.filter((s) => want.has(s.id)), (id, jpeg) => send('thumb', { id, jpeg }));
    return true;
});
ipcMain.handle('net', () => ({ interfaces: interfaces(), port: PORT, name: os.hostname(), id: server ? server.id : '' }));
ipcMain.handle('start', (e, opts) => { startCapture(opts); return true; });
ipcMain.handle('stop', () => { stopCapture('user'); return true; });
ipcMain.on('audio', (e, buf) => { if (server && current && current.audio) server.audio(Buffer.from(buf)); });

/* ---------- Запуск ---------- */

app.whenReady().then(async () => {
    server = new StreamServer();
    try {
        await server.start();
    } catch (e) {
        dialog.showErrorBox('PC Stream', 'Порт ' + PORT + ' занят. Возможно, PC Stream уже запущен.');
        app.quit();
        return;
    }
    server.on('clients', () => send('clients', server.list()));

    // Системный звук: getDisplayMedia в окне получает loopback-аудио всего ПК
    // Системный звук: getDisplayMedia в окне получает loopback-аудио всего ПК.
    // Видео нужно указать формально — отдаём собственное окно (без desktopCapturer).
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        callback({ video: request.frame, audio: audioMode });
    });

    createWindow();
});

app.on('window-all-closed', () => {
    stopCapture('quit');
    if (server) server.stop();
    app.quit();
});
