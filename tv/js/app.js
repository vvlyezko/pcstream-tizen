/* PC Stream — клиент для Samsung Tizen (Chromium 69: ES2017, без ?. и ??).
 * 1. Ищет компьютеры с PC Stream в локальной сети (HTTP :8787/info по своей подсети).
 * 2. Подключается по WebSocket :8787/stream.
 * 3. Видео — fMP4 во встроенный плеер через MSE (аппаратное декодирование), держим «живой край».
 * 4. Звук — PCM 48 кГц через WebAudio с небольшим буфером и настраиваемой задержкой.
 */
(function () {
    'use strict';

    var PORT = 8787;
    var K = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, ESC: 27, INFO: 457 };
    var T_INIT = 1, T_VIDEO = 2, T_AUDIO = 3;

    var $ = function (id) { return document.getElementById(id); };
    var store = {
        get: function (k, d) { try { var v = localStorage.getItem('pcs.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
        set: function (k, v) { try { localStorage.setItem('pcs.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
    };

    /* ---------------- Общее ---------------- */

    function registerKeys() {
        if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
        ['Info', 'MediaPlayPause'].forEach(function (k) { try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* ignore */ } });
    }

    function screenSaver(on) {
        try {
            webapis.appcommon.setScreenSaver(on ? webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON
                : webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
        } catch (e) { /* не TV */ }
    }

    function exitApp() {
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
    }

    function fit() { // в браузере масштабируем макет 1920×1080
        var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
        $('app').style.transform = Math.abs(s - 1) > 0.001 ? 'scale(' + s + ')' : '';
    }

    function fetchTimeout(url, ms) {
        var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
        return fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' }).then(function (r) {
            clearTimeout(t);
            if (!r.ok) throw new Error('http ' + r.status);
            return r.json();
        }, function (e) { clearTimeout(t); throw e; });
    }

    /* ---------------- Поиск компьютеров ---------------- */

    var found = {};          // id → { info, hosts: {ip: ms} }
    var scanning = false, scanGen = 0;

    /* Свой IP телевизора — чтобы сканировать именно свою подсеть.
       webapis.network.getIp() работает не на всех прошивках (на Q95T 2020 падает), поэтому
       дальше tizen.systeminfo (Ethernet и Wi-Fi) и WebRTC: Chromium 69 отдаёт локальный адрес. */
    var IP_RE = /^\d+\.\d+\.\d+\.\d+$/;

    function myIps() {
        var ips = [];
        function add(ip) { if (ip && IP_RE.test(ip) && ip !== '0.0.0.0' && ip.indexOf('127.') !== 0 && ips.indexOf(ip) < 0) ips.push(ip); }
        try { add(webapis.network.getIp()); } catch (e) { /* ignore */ }
        var jobs = [];
        if (window.tizen && tizen.systeminfo) {
            ['ETHERNET_NETWORK', 'WIFI_NETWORK'].forEach(function (p) {
                jobs.push(new Promise(function (resolve) {
                    try { tizen.systeminfo.getPropertyValue(p, function (v) { if (v && v.status === 'ON') add(v.ipAddress); resolve(); }, function () { resolve(); }); }
                    catch (e) { resolve(); }
                }));
            });
        }
        return Promise.all(jobs).then(function () {
            return ips.length ? ips : rtcIps().then(function (r) { r.forEach(add); return ips; });
        });
    }

    function rtcIps() {
        return new Promise(function (resolve) {
            var out = [], pc;
            setTimeout(function () { resolve(out); }, 2500);
            try {
                pc = new RTCPeerConnection({ iceServers: [] });
                pc.createDataChannel('ip');
                pc.onicecandidate = function (e) {
                    if (!e.candidate) { try { pc.close(); } catch (x) { /* ignore */ } resolve(out); return; }
                    var m = /(\d+\.\d+\.\d+\.\d+)/.exec(e.candidate.candidate);
                    if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
                };
                pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () { resolve(out); });
            } catch (e) { resolve(out); }
        });
    }

    function candidates() {
        return myIps().then(function (ips) {
            var list = [], seen = {};
            function add(h) { if (h && !seen[h]) { seen[h] = 1; list.push(h); } }
            add(store.get('lastHost', null));
            if (/^https?:/.test(location.protocol) && location.hostname) add(location.hostname); // отладка в браузере
            var bases = [];
            ips.forEach(function (ip) { var b = ip.split('.').slice(0, 3).join('.'); if (bases.indexOf(b) < 0) bases.push(b); });
            if (!bases.length) bases = ['192.168.1', '192.168.0', '10.0.0', '192.168.2'];
            bases.forEach(function (b) { for (var i = 1; i < 255; i++) if (ips.indexOf(b + '.' + i) < 0) add(b + '.' + i); });
            return list;
        });
    }

    function probe(host) {
        var t0 = Date.now();
        return fetchTimeout('http://' + host + ':' + PORT + '/info', 1500).then(function (info) {
            if (!info || info.app !== 'pcstream') return;
            var e = found[info.id] = found[info.id] || { hosts: {} };
            e.info = info;
            e.hosts[host] = Date.now() - t0;
            renderList();
            autoConnect(info.id);
        }).catch(function () { /* нет ответа */ });
    }

    function scan() {
        if (scanning) return;
        scanning = true;
        var my = ++scanGen;
        $('scanState').textContent = 'Поиск…';
        return candidates().then(function (list) { return scanList(list, my); }).then(function () {
            if (my !== scanGen) return; // поиск перезапущен — итог подведёт новый
            scanning = false;
            var n = Object.keys(found).length;
            $('scanState').textContent = n ? 'Найдено: ' + n : 'Ничего не найдено';
            renderList();
        });
    }

    function scanList(list, my) {
        var i = 0, active = 0;
        return new Promise(function (resolve) {
            function next() {
                if (my !== scanGen) return resolve();
                while (active < 40 && i < list.length) {
                    active++;
                    probe(list[i++]).then(function () { active--; next(); });
                }
                if (active === 0 && i >= list.length) resolve();
            }
            next();
        });
    }

    // Лучший адрес компьютера: проводной, если отвечает, иначе самый быстрый
    function bestHost(e) {
        var wired = (e.info.interfaces || []).filter(function (x) { return x.wired; }).map(function (x) { return x.address; });
        var hosts = Object.keys(e.hosts).sort(function (a, b) { return e.hosts[a] - e.hosts[b]; });
        for (var i = 0; i < hosts.length; i++) if (wired.indexOf(hosts[i]) >= 0) return hosts[i];
        return hosts[0];
    }

    var autoTried = false;
    function autoConnect(id) {
        if (autoTried || current) return;
        if (store.get('lastId', null) !== id) return;
        if (!found[id].info.streaming) return;
        autoTried = true;
        connect(found[id]);
    }

    function renderList() {
        var box = $('pcList');
        var keepId = focus && focus._pcId;
        box.innerHTML = '';
        var ids = Object.keys(found);
        if (!ids.length) {
            box.innerHTML = '<div class="empty">' + (scanning ? 'Ищем компьютеры в сети…' : 'Компьютеры с PC Stream не найдены') + '</div>';
        }
        ids.forEach(function (id) {
            var e = found[id], info = e.info, host = bestHost(e);
            var wired = (info.interfaces || []).some(function (x) { return x.address === host && x.wired; });
            var el = document.createElement('div');
            el.className = 'pc f';
            el._pcId = id;
            var m = info.meta;
            el.innerHTML =
                '<div class="pc-icon"><svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="12.5" rx="2.5"/><path d="M8 20.5h8M12 16.5v4"/></svg></div>' +
                '<div class="pc-main"><div class="pc-name"></div><div class="pc-sub"></div></div>' +
                '<div class="pc-state' + (info.streaming ? ' live' : '') + '"></div>';
            el.querySelector('.pc-name').textContent = info.name;
            el.querySelector('.pc-sub').textContent = host + (wired ? ' · кабель' : ' · Wi‑Fi') +
                (info.streaming && m ? ' · ' + m.label + ' ' + m.width + '×' + m.height : '');
            el.querySelector('.pc-state').textContent = info.streaming ? 'Идёт трансляция' : 'Ожидает запуска';
            el._select = function () { connect(e); };
            box.appendChild(el);
        });
        var items = homeItems();
        var again = items.filter(function (x) { return x._pcId && x._pcId === keepId; })[0];
        // пока пользователь не двигал фокус, держим его на первом найденном компьютере
        var keep = userMoved && focus && document.body.contains(focus) ? focus : null;
        if (screen === 'home') setFocus(again || keep || items[0]);
    }

    /* ---------------- Навигация (простая: вертикальный список + кнопки) ---------------- */

    var focus = null, screen = 'home', userMoved = false;

    function setFocus(el) {
        if (focus) focus.classList.remove('focused');
        focus = el || null;
        if (focus) focus.classList.add('focused');
    }

    function homeItems() { return Array.prototype.slice.call(document.querySelectorAll('#home .f')); }
    function osdItems() { return Array.prototype.slice.call(document.querySelectorAll('#osd .f')); }

    function moveIn(items, delta) {
        var i = items.indexOf(focus);
        var n = Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i + delta)));
        setFocus(items[n]);
    }

    /* ---------------- Подключение ---------------- */

    var current = null;   // { entry, host, ws }
    var reconnectTimer = null;

    function connect(entry) {
        autoTried = true; // автоподключение — только при запуске приложения, не после выхода по «Назад»
        disconnect(true);
        var host = bestHost(entry);
        store.set('lastHost', host);
        store.set('lastId', entry.info.id);
        current = { entry: entry, host: host, ws: null };
        showPlayer(entry.info);
        openSocket();
    }

    function openSocket() {
        if (!current) return;
        clearTimeout(reconnectTimer);
        var ws;
        try { ws = new WebSocket('ws://' + current.host + ':' + PORT + '/stream'); } catch (e) { scheduleReconnect(); return; }
        ws.binaryType = 'arraybuffer';
        current.ws = ws;
        waiting('Подключение к ' + current.entry.info.name + '…');
        ws.onopen = function () {
            var name = 'Samsung TV';
            try { name = 'Samsung ' + webapis.productinfo.getRealModel(); } catch (e) { /* ignore */ }
            ws.send(JSON.stringify({ type: 'hello', name: name }));
        };
        ws.onmessage = function (ev) {
            if (typeof ev.data === 'string') { onText(JSON.parse(ev.data)); return; }
            var u8 = new Uint8Array(ev.data);
            var type = u8[0];
            if (type === T_VIDEO) Video.push(u8.subarray(1));
            else if (type === T_AUDIO) Audio.push(ev.data);
            else if (type === T_INIT) Video.init(u8.subarray(1));
        };
        ws.onclose = function () {
            if (!current || current.ws !== ws) return;
            waiting('Соединение потеряно. Переподключение…');
            Video.reset();
            scheduleReconnect();
        };
        ws.onerror = function () { /* onclose сработает следом */ };
    }

    function scheduleReconnect() {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(openSocket, 2000);
    }


    var meta = null;
    function onText(m) {
        if (m.type === 'hello') {
            current.entry.info = m.server;
            if (!m.server.streaming) waiting('Компьютер подключён. Начните трансляцию в PC Stream на ПК.');
        } else if (m.type === 'start') {
            meta = m.meta;
            Video.setup(meta);
            Audio.start();
            $('osdSub').textContent = current.entry.info.name + ' · ' + meta.label;
            $('sRes').textContent = meta.width + '×' + meta.height;
            waiting('Запуск трансляции…');
        } else if (m.type === 'stop') {
            Video.reset();
            Audio.stop();
            waiting(m.reason === 'error' ? 'Трансляция прервалась на компьютере' : 'Трансляция остановлена на компьютере. Ожидание…');
        }
    }

    function disconnect(silent) {
        clearTimeout(reconnectTimer);
        if (current && current.ws) { var ws = current.ws; current.ws = null; try { ws.close(); } catch (e) { /* ignore */ } }
        current = null;
        Video.reset();
        Audio.stop();
        screenSaver(true);
        if (!silent) showHome();
    }

    /* ---------------- Видео (MSE) ---------------- */

    var Video = (function () {
        var video, ms = null, sb = null, codec = '', initSeg = null, queue = [], started = false;
        var frames = 0, bytes = 0, lastStats = Date.now();

        // Журнал для отладки через CDP: window.__pcs.log / window.__pcs.opt
        var dlog = [], opt = { rate: true, hold: true, trim: true, seek: true };
        function D(s) { dlog.push(Math.round(performance.now()) + ' ' + s); if (dlog.length > 300) dlog.shift(); }
        window.__pcs = { log: dlog, opt: opt, D: D };
        var onError = null, errTimes = [];
        (function () {
            var v = $('video');
            ['error', 'waiting', 'stalled', 'seeking', 'seeked', 'pause', 'play', 'playing', 'emptied', 'ratechange'].forEach(function (n) {
                v.addEventListener(n, function () {
                    D(n + ' t=' + v.currentTime.toFixed(3) + ' rs=' + v.readyState + (n === 'ratechange' ? ' rate=' + v.playbackRate : '') +
                        (v.error ? ' err=' + v.error.code + ' ' + (v.error.message || '') : ''));
                    if (n === 'error' && ms && onError) {
                        var now = Date.now();
                        errTimes = errTimes.filter(function (t) { return now - t < 30000; });
                        errTimes.push(now);
                        onError(errTimes.length);
                    }
                });
            });
        })();

        function setup(m) {
            reset();
            video = $('video');
            codec = m.codec;
            var type = 'video/mp4; codecs="' + codec + '"';
            if (!window.MediaSource || !MediaSource.isTypeSupported(type)) {
                waiting('Телевизор не поддерживает формат ' + codec);
                return;
            }
            ms = new MediaSource();
            video.src = URL.createObjectURL(ms);
            ms.addEventListener('sourceopen', function () {
                if (!ms || sb) return;
                try {
                    sb = ms.addSourceBuffer(type);
                    sb.mode = 'segments';
                    sb.addEventListener('updateend', pump);
                } catch (e) { waiting('Ошибка видеоплеера: ' + e.message); return; }
                if (initSeg) queue.unshift(initSeg);
                pump();
            });
        }

        function init(u8) {
            initSeg = u8.slice();
            if (sb) { queue = [initSeg]; pump(); }
        }

        // Фрагмент от нашего муксера: tfdt (время, 90 кГц) на смещении 60, флаги кадра — на 96
        var keyTime = -1, waitKey = false;

        function push(u8) {
            if (!ms) return;
            var key = u8.length > 100 && u8[96] === 0x02;
            if (waitKey && !key) return;
            if (key) {
                waitKey = false;
                keyTime = ((u8[60] * 16777216 + (u8[61] << 16 | u8[62] << 8 | u8[63])) * 4294967296 +
                    (u8[64] * 16777216 + (u8[65] << 16 | u8[66] << 8 | u8[67]))) / 90000;
            }
            frames++; bytes += u8.length;
            // переполнение: выкидываем всё и ждём ключевой кадр (выброс середины GOP ломает декодер)
            if (queue.length > 240) { queue = queue[0] === initSeg ? [initSeg] : []; waitKey = !key; if (!key) return; }
            queue.push(u8.slice ? u8.slice() : u8);
            pump();
        }

        // Склеиваем накопившиеся кадры в одно добавление — меньше нагрузки на TV
        function pump() {
            if (!sb || sb.updating || !queue.length || ms.readyState !== 'open') return;
            var total = 0, i;
            for (i = 0; i < queue.length; i++) total += queue[i].length;
            var data = new Uint8Array(total), off = 0;
            for (i = 0; i < queue.length; i++) { data.set(queue[i], off); off += queue[i].length; }
            queue = [];
            try { sb.appendBuffer(data); } catch (e) {
                D('append ' + e.name + ' ' + e.message);
                if (e.name === 'QuotaExceededError') trim(true);
            }
            if (!started && video.buffered.length) {
                started = true;
                D('start at ' + video.buffered.start(0).toFixed(3));
                video.currentTime = video.buffered.start(0);
                var p = video.play();
                if (p && p.catch) p.catch(function () { /* ignore */ });
                hideWaiting();
                screenSaver(false);
            }
        }

        function trim(force) {
            if (!sb || sb.updating || !video.buffered.length) return;
            var start = video.buffered.start(0), cut = video.currentTime - 4;
            if (!force && !opt.trim) return;
            if (cut - start > (force ? 0.5 : 8)) { D('remove ' + start.toFixed(2) + '-' + cut.toFixed(2)); try { sb.remove(start, cut); } catch (e) { D('remove ' + e.name); } }
        }

        /* Держим воспроизведение у «живого края».
           - догнали последний кадр (экран/окно не меняется) — пауза, чтобы часы плеера не убежали
             вперёд и новые кадры не оказались «в прошлом»; новый кадр — снова play;
           - отстаём — ускоряемся, сильно отстали — прыжок к краю. */
        var holding = false;

        function play() { var p = video.play(); if (p && p.catch) p.catch(function () { /* ignore */ }); }

        /* Tizen: смена playbackRate на ходу вешает (а то и роняет) аппаратный плеер, а seek
           всегда округляется вниз до ключевого кадра. Поэтому скорость не трогаем, а при
           устойчивом отставании прыгаем ровно на свежий ключевой кадр, когда он уже в буфере. */
        var lagEma = 0.4;
        var TIZEN = typeof tizen !== 'undefined' || /Tizen/i.test(navigator.userAgent);
        var lagSince = 0, lastJump = 0;

        function tizenEdge(end, lag) {
            var now = Date.now();
            // Плееру Tizen нужен свой запас (~0,3–0,6 с в зависимости от разрешения): после прыжка он
            // всё равно его набирает, а каждый прыжок — рывок картинки и заикание звука. Поэтому
            // прыгаем только при настоящем отставании.
            // Прыжок ровно на только что пришедший ключевой кадр даёт минимальную задержку (~0,5 с);
            // лишний запас (0,8+ с) убираем не чаще раза в 30 с, чтобы не было частых рывков.
            if (lag > 0.8) { if (!lagSince) lagSince = now; } else lagSince = 0;
            var stuck = video.currentTime < video.buffered.start(0);
            var due = stuck || lag > 3 || (lagSince && now - lagSince > 5000 && now - lastJump > 30000);
            if (due && keyTime > video.currentTime + 0.1 && keyTime <= end && (stuck || lag > 3 || end - keyTime < 0.15) && keyTime >= video.buffered.start(0)) {
                D('jump to key ' + keyTime.toFixed(3) + ' lag=' + lag.toFixed(3));
                lastJump = now;
                video.currentTime = keyTime;
                lagSince = 0;
                if (video.paused) play();
            }
        }

        function liveEdge() {
            if (!sb || !video || !video.buffered.length || !started) return;
            var end = video.buffered.end(video.buffered.length - 1);
            var lag = end - video.currentTime;
            if (lag >= 0 && lag < 5) lagEma = lagEma * 0.97 + lag * 0.03;
            if (TIZEN) tizenEdge(end, lag);
            else browserEdge(end, lag);
            var now = Date.now();
            if (now - lastStats >= 1000) {
                var sec = (now - lastStats) / 1000;
                $('sFps').textContent = Math.round(frames / sec);
                $('sMbps').textContent = (bytes * 8 / sec / 1e6).toFixed(1);
                $('sLag').textContent = Math.round(lag * 1000) + ' мс';
                frames = 0; bytes = 0; lastStats = now;
                trim(false);
            }
        }

        function browserEdge(end, lag) {
            if (opt.seek && (video.currentTime < video.buffered.start(0) || lag > 1.0)) {
                D('jump lag=' + lag.toFixed(3));
                video.currentTime = Math.max(video.buffered.start(0), end - 0.05);
                lag = 0.05;
            }
            if (opt.hold && lag < 0.025) {
                if (!video.paused) { video.pause(); holding = true; }
            } else if (holding || video.paused) {
                if (lag > 0.04 || !opt.hold) { holding = false; play(); }
            }
            // целевой запас ~0,1 с: больше — подгоняем ускорением
            var rate = !opt.rate ? 1 : lag > 0.4 ? 1.25 : lag > 0.16 ? 1.1 : lag < 0.09 ? 1 : video.playbackRate;
            if (video.playbackRate !== rate) video.playbackRate = rate;
        }

        function reset() {
            queue = []; started = false; sb = null; holding = false; keyTime = -1; waitKey = false; lagSince = 0;
            if (ms) {
                try { if (ms.readyState === 'open') ms.endOfStream(); } catch (e) { /* ignore */ }
                ms = null;
            }
            video = $('video');
            if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); try { video.load(); } catch (e) { /* ignore */ } }
            video.playbackRate = 1;
        }

        setInterval(liveEdge, 50);
        return { setup: setup, init: init, push: push, reset: reset, lag: function () { return lagEma; }, onError: function (fn) { onError = fn; } };
    })();

    // Декодер упал — переоткрываем соединение: сервер заново пришлёт init и начнёт с ключевого кадра
    Video.onError(function (count) {
        if (!current || !current.ws) return;
        var ws = current.ws;
        current.ws = null;
        try { ws.close(); } catch (e) { /* ignore */ }
        Video.reset();
        if (count > 5) { waiting('Телевизор не может декодировать поток. Попробуйте меньший битрейт или окно.'); return; }
        waiting('Восстановление видео…');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(openSocket, 300);
    });

    /* ---------------- Звук (WebAudio) ---------------- */

    var Audio = (function () {
        var ctx = null, gain = null, next = 0, on = false;
        var RATE = 48000;
        // Звук держим вровень с картинкой: цель = сглаженная задержка видео + ручной сдвиг пользователя
        var delayMs = store.get('audioShift', 0);
        // Статистика для отладки (window.__pcs.a): недогрузы, переполнения, паузы между пакетами
        var st = { mode: '', packets: 0, under: 0, over: 0, maxGap: 0, gaps100: 0, lastAt: 0, stalls: 0, maxStall: 0 };
        (function () {
            var last = Date.now();
            setInterval(function () {
                var now = Date.now(), d = now - last - 50;
                last = now;
                if (d > 100) { st.stalls++; if (d > st.maxStall) st.maxStall = d; }
            }, 50);
        })();
        if (window.__pcs) window.__pcs.a = st;

        /* Основной путь — AudioWorklet (js/pcm-player.js): один непрерывный поток в звуковом
           потоке браузера. Раньше каждый 20-мс пакет был отдельным AudioBufferSourceNode со своим
           пересчётом 48→44,1 кГц: на стыках Chromium 69 давал искажения и «эхо». */
        var node = null, workletState = '', lastTarget = -1;

        function target() { return Math.max(0.08, 0.04 + Math.min(0.9, Video.lag()) + delayMs / 1000); }

        function loadText(path) {
            return new Promise(function (resolve, reject) {
                var x = new XMLHttpRequest();
                x.open('GET', path);
                x.onload = function () { if (x.responseText) resolve(x.responseText); else reject(new Error('empty ' + path)); };
                x.onerror = function () { reject(new Error('xhr ' + path)); };
                x.send();
            });
        }

        function initWorklet() {
            if (workletState) return;
            workletState = 'loading';
            if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') { workletState = 'none'; st.mode = 'nodes'; return; }
            // модуль из file:// worklet не грузит (CORS) — читаем текст и подключаем через blob:
            loadText('js/pcm-player.js').then(function (code) {
                var url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
                return ctx.audioWorklet.addModule(url).catch(function () {
                    return ctx.audioWorklet.addModule('data:application/javascript;charset=utf-8,' + encodeURIComponent(code));
                });
            }).then(function () {
                node = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
                node.connect(gain);
                node.port.onmessage = function (e) { st.w = e.data; };
                workletState = 'ready';
                st.mode = 'worklet';
                lastTarget = -1;
            }).catch(function (e) {
                workletState = 'none';
                st.mode = 'nodes';
                if (window.__pcs) window.__pcs.D('worklet failed: ' + (e && e.message));
            });
        }

        function start() {
            if (!ctx) {
                var AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                ctx = new AC();
                gain = ctx.createGain();
                gain.connect(ctx.destination);
                initWorklet();
            }
            if (ctx.state === 'suspended') ctx.resume();
            if (node) node.port.postMessage({ reset: true });
            next = 0;
            lastTarget = -1;
            on = true;
        }

        function stop() {
            on = false; next = 0;
            if (node) node.port.postMessage({ reset: true });
        }

        function push(ab) {
            if (!on || !ctx) return;
            var at = Date.now();
            if (st.lastAt) { var g = at - st.lastAt; if (g > st.maxGap) st.maxGap = g; if (g > 100) st.gaps100++; }
            st.prevAt = st.lastAt; st.lastAt = at; st.packets++;
            if (workletState === 'loading') return; // первые доли секунды, пока грузится модуль
            if (node) {
                var t = target();
                var msg = { pcm: ab.slice(2) }; // без 2 байт заголовка; передаём без копирования
                if (Math.abs(t - lastTarget) > 0.02) { msg.target = t; lastTarget = t; }
                node.port.postMessage(msg, [msg.pcm]);
                return;
            }
            pushNodes(ab, at);
        }

        // Запасной путь, если AudioWorklet недоступен: по узлу на пакет
        function pushNodes(ab, at) {
            var pcm = new Int16Array(ab, 2, (ab.byteLength - 2) >> 1); // 1 байт типа + выравнивание
            var frames = pcm.length >> 1;
            if (!frames) return;
            var buf = ctx.createBuffer(2, frames, RATE);
            var L = buf.getChannelData(0), R = buf.getChannelData(1);
            for (var i = 0; i < frames; i++) { L[i] = pcm[i * 2] / 32768; R[i] = pcm[i * 2 + 1] / 32768; }
            var src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(gain);
            var now = ctx.currentTime, tg = target();
            if (next < now + 0.01) { if (next) st.under++; next = now + tg; }
            else if (Math.abs(next - (now + tg)) > 0.25) {
                st.over++;
                if (window.__pcs) window.__pcs.D('a-resync dev=' + (next - now - tg).toFixed(3) + ' target=' + tg.toFixed(3) + ' gap=' + (at - (st.prevAt || at)));
                next = now + tg;
            }
            src.start(next);
            next += frames / RATE;
        }

        function shiftDelay(d) {
            delayMs = Math.max(-400, Math.min(600, delayMs + d));
            store.set('audioShift', delayMs);
            next = 0; // применится на следующем пакете
            lastTarget = -1;
            return delayMs;
        }

        function fmt() { return (delayMs > 0 ? '+' : '') + delayMs; }
        return { start: start, stop: stop, push: push, shiftDelay: function (d) { shiftDelay(d); return fmt(); }, delay: fmt };
    })();

    /* ---------------- Экраны ---------------- */

    var waitingOn = false;
    function waiting(text) { waitingOn = true; $('waitingText').textContent = text; $('waiting').classList.remove('hidden'); }
    function hideWaiting() { waitingOn = false; $('waiting').classList.add('hidden'); }

    var osdTimer = null;
    function showOsd() {
        $('osd').classList.remove('hidden');
        $('delayVal').textContent = Audio.delay();
        if (!focus || osdItems().indexOf(focus) < 0) setFocus(osdItems()[0]);
        clearTimeout(osdTimer);
        osdTimer = setTimeout(hideOsd, 6000);
    }
    function hideOsd() { $('osd').classList.add('hidden'); clearTimeout(osdTimer); setFocus(null); }
    function osdVisible() { return !$('osd').classList.contains('hidden'); }

    function showPlayer(info) {
        screen = 'player';
        $('home').classList.add('hidden');
        $('player').classList.remove('hidden');
        $('osdTitle').textContent = info.name;
        $('osdSub').textContent = info.name;
        setFocus(null);
    }

    function showHome() {
        screen = 'home';
        hideOsd();
        $('player').classList.add('hidden');
        $('home').classList.remove('hidden');
        renderList();
        scan();
    }

    /* ---------------- Клавиши ---------------- */

    document.addEventListener('keydown', function (e) {
        var c = e.keyCode;
        if (screen === 'home') {
            if (c === K.UP) { userMoved = true; moveIn(homeItems(), -1); }
            else if (c === K.DOWN) { userMoved = true; moveIn(homeItems(), 1); }
            else if (c === K.ENTER && focus && focus._select) focus._select();
            else if (c === K.BACK || c === K.ESC) exitApp();
            else return;
            e.preventDefault();
            return;
        }
        // экран просмотра
        if (osdVisible()) {
            clearTimeout(osdTimer);
            osdTimer = setTimeout(hideOsd, 6000);
            if (c === K.LEFT || c === K.RIGHT) {
                if (focus === $('delayBtn')) $('delayVal').textContent = Audio.shiftDelay(c === K.RIGHT ? 20 : -20);
                else moveIn(osdItems(), c === K.RIGHT ? 1 : -1);
            } else if (c === K.UP || c === K.DOWN) moveIn(osdItems(), c === K.DOWN ? 1 : -1);
            else if (c === K.ENTER) { if (focus === $('disconnectBtn')) disconnect(false); else moveIn(osdItems(), 1); }
            else if (c === K.BACK || c === K.ESC) hideOsd();
            else return;
            e.preventDefault();
            return;
        }
        if (c === K.BACK || c === K.ESC) { disconnect(false); e.preventDefault(); return; }
        if (c === K.ENTER || c === K.UP || c === K.DOWN || c === K.INFO) { showOsd(); e.preventDefault(); }
    });

    document.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('.f') : null;
        if (!el) return;
        setFocus(el);
        if (el._select) el._select();
        if (el.id === 'disconnectBtn') disconnect(false);
    });

    /* ---------------- Запуск ---------------- */

    // «Искать снова» во время поиска: отменяем текущий (scanGen) и начинаем заново
    $('rescanBtn')._select = function () { scanGen++; scanning = false; found = {}; renderList(); scan(); };
    registerKeys();
    fit();
    window.addEventListener('resize', fit);
    document.addEventListener('visibilitychange', function () {
        if (document.hidden && current) disconnect(true);
        else if (!document.hidden && screen !== 'home') showHome();
    });
    showHome();
})();
