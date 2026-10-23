'use strict';
// Тестовый клиент WebSocket: подключается как телевизор и считает пакеты.
// node test/ws-client.js [host] [seconds]
const net = require('net');
const crypto = require('crypto');

const host = process.argv[2] || '127.0.0.1';
const secs = +(process.argv[3] || 5);
const sock = net.connect(8787, host);
const key = crypto.randomBytes(16).toString('base64');
let handshake = false, buf = Buffer.alloc(0);
const st = { text: [], init: 0, video: 0, key: 0, audio: 0, audioBytes: 0, videoBytes: 0, firstVideoMs: null, lastAudio: 0, maxGap: 0, gaps60: 0 };
const t0 = Date.now();

sock.on('connect', () => sock.write(
    'GET /stream HTTP/1.1\r\nHost: ' + host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\nUser-Agent: test-client\r\n\r\n'));

sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!handshake) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        handshake = true;
        buf = buf.subarray(i + 4);
        // приветствие от клиента (маскированный текстовый кадр)
        const msg = Buffer.from(JSON.stringify({ type: 'hello', name: 'Тестовый клиент' }));
        const mask = crypto.randomBytes(4);
        const head = Buffer.from([0x81, 0x80 | msg.length]);
        sock.write(Buffer.concat([head, mask, Buffer.from(msg.map((b, j) => b ^ mask[j & 3]))]));
    }
    while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const p = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 1) st.text.push(JSON.parse(p.toString()).type);
        else if (op === 2) {
            const type = p[0];
            if (type === 1) st.init++;
            if (type === 2) {
                st.video++; st.videoBytes += p.length;
                if (st.firstVideoMs == null) st.firstVideoMs = Date.now() - t0;
                // sample_flags в trun: не-ключевой кадр имеет бит 0x10000
                const i = p.indexOf('trun');
                if (i > 0 && !(p.readUInt32BE(i + 24) & 0x10000)) st.key++;
            }
            if (type === 3) {
                st.audio++; st.audioBytes += p.length - 1;
                const now = Date.now();
                if (st.lastAudio) { const g = now - st.lastAudio; if (g > st.maxGap) st.maxGap = g; if (g > 60) st.gaps60++; }
                st.lastAudio = now;
            }
        }
    }
});

setTimeout(() => {
    const s = (Date.now() - t0) / 1000;
    console.log(JSON.stringify({
        messages: st.text, init: st.init, video: st.video, keyframes: st.key,
        videoFps: +(st.video / s).toFixed(1), videoMbps: +(st.videoBytes * 8 / s / 1e6).toFixed(1),
        firstVideoMs: st.firstVideoMs, audioPackets: st.audio, audioKbps: Math.round(st.audioBytes * 8 / s / 1000), audioMaxGapMs: st.maxGap, audioGapsOver60ms: st.gaps60
    }, null, 1));
    sock.destroy();
}, secs * 1000);
