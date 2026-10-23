'use strict';
/*
 * Список источников и миниатюры без desktopCapturer.
 * desktopCapturer.getSources с миниатюрами окон течёт памятью в главном процессе Electron
 * (~25 МБ на вызов), поэтому:
 *  - окна перечисляет bin/winlist.exe (Win32 EnumWindows, завершается сразу);
 *  - миниатюры — один кадр через FFmpeg (процесс завершается и забирает память с собой);
 *  - иконки программ — app.getFileIcon, один раз на exe.
 */

const { execFile, spawn } = require('child_process');
const path = require('path');
const { app, screen } = require('electron');
const { ffmpegPath } = require('./capture');

const BIN = path.dirname(ffmpegPath());
const THUMB_TTL = 10000;

const thumbs = new Map();   // id → { jpeg, t }
const icons = new Map();    // exe → Buffer (PNG) | null

function run(file, args, timeout) {
    return new Promise((resolve) => {
        execFile(file, args, { windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout },
            (err, stdout) => resolve(err ? null : stdout));
    });
}

async function icon(exe) {
    if (!exe) return null;
    if (icons.has(exe)) return icons.get(exe);
    let png = null;
    try {
        const img = await app.getFileIcon(exe, { size: 'normal' });
        if (!img.isEmpty()) png = img.toPNG();
    } catch (e) { /* нет доступа к exe */ }
    icons.set(exe, png);
    return png;
}

async function list() {
    const out = [];
    screen.getAllDisplays().forEach((d, i, all) => {
        const size = Math.round(d.size.width * d.scaleFactor) + '×' + Math.round(d.size.height * d.scaleFactor);
        out.push({ id: 'screen:' + i, kind: 'screen', output: i, w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor), name: all.length > 1 ? 'Экран ' + (i + 1) + ' (' + size + ')' : 'Весь экран (' + size + ')' });
    });
    const raw = await run(path.join(BIN, 'winlist.exe'), [], 3000);
    let wins = [];
    try { wins = JSON.parse(raw ? raw.toString('utf8') : '[]'); } catch (e) { wins = []; }
    for (const w of wins) {
        if (w.pid === process.pid) continue; // своё окно
        out.push({
            id: 'window:' + w.hwnd, kind: 'window', hwnd: w.hwnd, name: w.title, minimized: w.min,
            exe: w.exe, icon: await icon(w.exe)
        });
    }
    const alive = new Set(out.map((s) => s.id));
    Array.from(thumbs.keys()).forEach((id) => { if (!alive.has(id)) thumbs.delete(id); });
    out.forEach((s) => { const t = thumbs.get(s.id); s.thumb = t ? t.jpeg : null; });
    return out;
}

// Один кадр источника → JPEG 320 px
function grab(src) {
    const input = src.kind === 'screen'
        ? 'ddagrab=output_idx=' + (src.output || 0) + ':framerate=10:draw_mouse=0'
        : 'gfxcapture=hwnd=' + src.hwnd + ':capture_cursor=0:max_framerate=10';
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', input,
        '-vf', 'hwdownload,format=bgra,scale=320:-2', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', 'pipe:1'];
    return new Promise((resolve) => {
        const chunks = [];
        const p = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } }, 4000);
        p.stdout.on('data', (d) => chunks.push(d));
        p.on('error', () => { clearTimeout(timer); resolve(null); });
        p.on('exit', () => {
            clearTimeout(timer);
            const jpeg = Buffer.concat(chunks);
            resolve(jpeg.length > 100 ? jpeg : null);
        });
    });
}

// Миниатюры для списка источников; onThumb(id, jpeg) вызывается по мере готовности
let busy = false;
async function refreshThumbs(srcs, onThumb) {
    if (busy) return;
    busy = true;
    try {
        const todo = srcs.filter((s) => !s.minimized && !(thumbs.has(s.id) && Date.now() - thumbs.get(s.id).t < THUMB_TTL));
        let i = 0;
        const worker = async () => {
            while (i < todo.length) {
                const s = todo[i++];
                const jpeg = await grab(s);
                if (jpeg) { thumbs.set(s.id, { jpeg, t: Date.now() }); onThumb(s.id, jpeg); }
            }
        };
        await Promise.all([worker(), worker()]);
    } finally { busy = false; }
}

module.exports = { list, refreshThumbs };
