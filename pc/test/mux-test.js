'use strict';
// Проверка цепочки FFmpeg → FLV → fMP4: пишет 3 секунды в файл для ffprobe.
// node test/mux-test.js [screen|window:<hwnd>] out.mp4
const fs = require('fs');
const { Capture } = require('../src/capture');

const mode = process.argv[2] || 'screen';
const out = process.argv[3] || 'out.mp4';
const opts = mode.indexOf('window:') === 0
    ? { kind: 'window', hwnd: mode.split(':')[1], fps: 60, bitrate: 15, cursor: true, label: 'test' }
    : { kind: 'screen', output: 0, fps: 60, bitrate: 20, cursor: true, label: 'test' };

const file = fs.createWriteStream(out);
const cap = new Capture(opts);
let frames = 0, keys = 0, bytes = 0;
const t0 = Date.now();
cap.on('init', (init, meta) => { console.log('init', init.length, 'bytes', JSON.stringify(meta)); file.write(init); });
cap.on('fragment', (f) => { frames++; if (f.key) keys++; bytes += f.data.length; file.write(f.data); });
cap.on('exit', (code, log) => console.log('ffmpeg exit', code, log));
cap.on('error', (e) => console.error('error', e));
cap.start();
setTimeout(() => {
    cap.stop();
    const sec = (Date.now() - t0) / 1000;
    console.log(`frames=${frames} keys=${keys} fps=${(frames / sec).toFixed(1)} Mbit/s=${(bytes * 8 / sec / 1e6).toFixed(1)}`);
    file.end();
}, 3000);
