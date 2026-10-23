'use strict';
/*
 * HTTP + WebSocket сервер без внешних зависимостей.
 *  GET /info   — описание ПК для поиска с телевизора (CORS открыт)
 *  WS  /stream — поток: текстовые JSON-сообщения + бинарные пакеты
 *                [1] init-сегмент fMP4, [2] фрагмент кадра, [3] PCM-звук s16le 48 кГц стерео
 * Слушает все интерфейсы сразу (кабель и Wi-Fi).
 */

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');

const PORT = 8787;
const MAX_QUEUE = 3 * 1024 * 1024; // больше — клиент не успевает, пропускаем кадры до ключевого

const T_INIT = 1, T_VIDEO = 2, T_AUDIO = 3;

function interfaces() {
    const out = [];
    const all = os.networkInterfaces();
    Object.keys(all).forEach((name) => {
        all[name].forEach((a) => {
            if (a.family !== 'IPv4' || a.internal) return;
            if (/^169\.254\./.test(a.address)) return;
            const wifi = /wi-?fi|wlan|wireless|беспровод/i.test(name);
            const virtual = /vethernet|virtual|vmware|vbox|hyper-v|loopback|wsl|tailscale|zerotier|vpn/i.test(name);
            if (virtual) return;
            out.push({ name, address: a.address, wired: !wifi });
        });
    });
    // проводной — первым
    return out.sort((a, b) => (b.wired ? 1 : 0) - (a.wired ? 1 : 0));
}

function frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | opcode;
    return [head, payload];
}

class Client extends EventEmitter {
    constructor(sock, req) {
        super();
        this.sock = sock;
        this.addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        this.ua = req.headers['user-agent'] || '';
        this.needKey = true;
        this.alive = true;
        this.buf = Buffer.alloc(0);
        this.name = '';
        sock.setNoDelay(true);
        sock.on('data', (d) => this._read(d));
        sock.on('close', () => this._close());
        sock.on('error', () => this._close());
    }

    get congested() { return this.sock.writableLength > MAX_QUEUE; }

    send(opcode, payload) {
        if (!this.alive) return;
        const parts = frame(opcode, payload);
        this.sock.cork();
        this.sock.write(parts[0]);
        this.sock.write(parts[1]);
        this.sock.uncork();
    }

    json(obj) { this.send(1, Buffer.from(JSON.stringify(obj))); }

    packet(type, data) { this.send(2, Buffer.concat([Buffer.from([type]), data])); }

    _read(d) {
        this.buf = Buffer.concat([this.buf, d]);
        while (this.buf.length >= 2) {
            const op = this.buf[0] & 0x0f;
            const masked = this.buf[1] & 0x80;
            let len = this.buf[1] & 0x7f, off = 2;
            if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
            const maskOff = off;
            if (masked) off += 4;
            if (this.buf.length < off + len) return;
            let payload = Buffer.from(this.buf.subarray(off, off + len));
            if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= this.buf[maskOff + (i & 3)];
            this.buf = this.buf.subarray(off + len);
            if (op === 8) { this.close(); return; }
            if (op === 9) { this.send(10, payload); continue; }
            if (op === 1) {
                try { this.emit('message', JSON.parse(payload.toString('utf8'))); } catch (e) { /* ignore */ }
            }
        }
    }

    close() {
        if (!this.alive) return;
        try { this.sock.end(Buffer.from([0x88, 0])); } catch (e) { /* ignore */ }
        this._close();
    }

    _close() {
        if (!this.alive) return;
        this.alive = false;
        try { this.sock.destroy(); } catch (e) { /* ignore */ }
        this.emit('close');
    }
}

class StreamServer extends EventEmitter {
    constructor() {
        super();
        this.clients = new Set();
        this.init = null;       // init-сегмент текущей трансляции
        this.meta = null;       // { codec, width, height, fps, label }
        this.streaming = false;
        this.id = crypto.createHash('sha1').update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 12);
        this.stats = { bytes: 0, frames: 0, dropped: 0 };
    }

    start() {
        this.http = http.createServer((req, res) => this._http(req, res));
        this.http.on('upgrade', (req, sock) => this._upgrade(req, sock));
        return new Promise((resolve, reject) => {
            this.http.once('error', reject);
            this.http.listen(PORT, '0.0.0.0', () => resolve(PORT));
        });
    }

    info() {
        return {
            app: 'pcstream', version: 1, id: this.id, name: os.hostname(),
            streaming: this.streaming, meta: this.meta, clients: this.clients.size,
            interfaces: interfaces()
        };
    }

    _http(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store');
        if (req.url.indexOf('/info') === 0) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(this.info()));
            return;
        }
        res.statusCode = 404;
        res.end('PC Stream');
    }

    _upgrade(req, sock) {
        const key = req.headers['sec-websocket-key'];
        if (!key || req.url.indexOf('/stream') !== 0) { sock.destroy(); return; }
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const c = new Client(sock, req);
        this.clients.add(c);
        c.on('message', (m) => {
            if (m.type === 'hello') { c.name = m.name || ''; this.emit('clients'); }
            if (m.type === 'keyframe') c.needKey = true;
        });
        c.on('close', () => { this.clients.delete(c); this.emit('clients'); });
        this._greet(c);
        this.emit('clients');
    }

    _greet(c) {
        c.json({ type: 'hello', server: this.info() });
        if (this.streaming && this.init) {
            c.json({ type: 'start', meta: this.meta });
            c.packet(T_INIT, this.init);
            c.needKey = true;
        }
    }

    // Начало новой трансляции (или смена источника)
    begin(meta, init) {
        this.meta = meta;
        this.init = init;
        this.streaming = true;
        this.clients.forEach((c) => {
            c.json({ type: 'start', meta });
            c.packet(T_INIT, init);
            c.needKey = true;
        });
        this.emit('clients');
    }

    end(reason) {
        this.streaming = false;
        this.init = null;
        this.clients.forEach((c) => c.json({ type: 'stop', reason: reason || '' }));
        this.emit('clients');
    }

    video(frag) {
        this.stats.frames++;
        this.stats.bytes += frag.data.length;
        this.clients.forEach((c) => {
            if (c.needKey && !frag.key) return;
            if (c.congested) { c.needKey = true; this.stats.dropped++; return; }
            c.needKey = false;
            c.packet(T_VIDEO, frag.data);
        });
    }

    // [3][0][PCM s16le...] — второй байт выравнивает отсчёты по 2 байта для Int16Array на TV
    audio(pcm) {
        if (!this.clients.size) return;
        const pkt = Buffer.concat([Buffer.from([T_AUDIO, 0]), pcm]);
        this.clients.forEach((c) => {
            if (!c.congested) c.send(2, pkt);
        });
    }

    list() {
        return Array.from(this.clients).map((c) => ({ addr: c.addr, name: c.name || (/Tizen/.test(c.ua) ? 'Samsung TV' : 'Клиент') }));
    }

    stop() {
        this.clients.forEach((c) => c.close());
        if (this.http) this.http.close();
    }
}

module.exports = { StreamServer, interfaces, PORT };
