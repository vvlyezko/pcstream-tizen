'use strict';
/*
 * Медиа-утилиты сервера:
 *  - FlvParser  — разбирает поток FLV от FFmpeg (каждый кадр приходит сразу и с явным размером);
 *  - Fmp4Muxer  — упаковывает кадры H.264/HEVC во фрагменты fMP4 для MSE на телевизоре
 *                 (init-сегмент + moof/mdat на каждый кадр, без задержки на следующий кадр);
 *  - parseAvcC / parseHvcC — строка кодека и ширина/высота из SPS.
 */

const { EventEmitter } = require('events');

/* ---------------- FLV ---------------- */

class FlvParser extends EventEmitter {
    constructor() {
        super();
        this.buf = Buffer.alloc(0);
        this.headerDone = false;
    }

    push(chunk) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        if (!this.headerDone) {
            if (this.buf.length < 13) return;
            if (this.buf.toString('latin1', 0, 3) !== 'FLV') throw new Error('not an FLV stream');
            const headerSize = this.buf.readUInt32BE(5);
            this.buf = this.buf.subarray(headerSize + 4); // + PreviousTagSize0
            this.headerDone = true;
        }
        while (this.buf.length >= 11) {
            const type = this.buf[0];
            const size = this.buf.readUIntBE(1, 3);
            const total = 11 + size + 4;
            if (this.buf.length < total) break;
            const ts = this.buf.readUIntBE(4, 3) | (this.buf[7] << 24);
            const data = this.buf.subarray(11, 11 + size);
            this.buf = this.buf.subarray(total);
            if (type === 9) this._video(data, ts);
        }
    }

    _video(d, ts) {
        if (d.length < 5) return;
        if (d[0] & 0x80) { this._videoEx(d, ts); return; }
        const frameType = d[0] >> 4;
        const codecId = d[0] & 0x0f;
        if (codecId !== 7) return; // только AVC
        const pktType = d[1];
        const cts = (d.readIntBE(2, 3));
        const body = Buffer.from(d.subarray(5));
        if (pktType === 0) this.emit('config', body, 'avc1');   // AVCDecoderConfigurationRecord
        else if (pktType === 1) this.emit('frame', { data: body, key: frameType === 1, dts: ts, cts });
    }

    // Enhanced FLV (так FFmpeg пишет HEVC): [1|frameType:3|packetType:4][FourCC][данные]
    _videoEx(d, ts) {
        const frameType = (d[0] >> 4) & 7;
        const pktType = d[0] & 0x0f;
        const fourcc = d.toString('latin1', 1, 5);
        if (fourcc !== 'hvc1') return;
        if (pktType === 0) this.emit('config', Buffer.from(d.subarray(5)), fourcc);  // HEVCDecoderConfigurationRecord
        else if (pktType === 1 && d.length > 8) {                                    // CodedFrames (+ cts)
            this.emit('frame', { data: Buffer.from(d.subarray(8)), key: frameType === 1, dts: ts, cts: d.readIntBE(5, 3) });
        } else if (pktType === 3) {                                                  // CodedFramesX (cts = 0)
            this.emit('frame', { data: Buffer.from(d.subarray(5)), key: frameType === 1, dts: ts, cts: 0 });
        }
    }
}

/* ---------------- SPS ---------------- */

class BitReader {
    constructor(buf) { this.buf = buf; this.pos = 0; }
    bit() { const b = (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return b; }
    bits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v * 2) + this.bit(); return v; }
    ue() { let z = 0; while (this.bit() === 0 && z < 32) z++; return z ? (2 ** z - 1 + this.bits(z)) : 0; }
    se() { const v = this.ue(); return v & 1 ? (v + 1) / 2 : -v / 2; }
}

function unescapeRbsp(nal) {
    const out = [];
    for (let i = 0; i < nal.length; i++) {
        if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
        out.push(nal[i]);
    }
    return Buffer.from(out);
}

function parseSps(sps) {
    const r = new BitReader(unescapeRbsp(sps.subarray(1)));
    const profile = r.bits(8); r.bits(8); r.bits(8); r.ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
        chroma = r.ue();
        if (chroma === 3) r.bit();
        r.ue(); r.ue(); r.bit();
        if (r.bit()) { // seq_scaling_matrix_present_flag
            for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
                if (r.bit()) {
                    const size = i < 6 ? 16 : 64;
                    let last = 8, next = 8;
                    for (let j = 0; j < size; j++) {
                        if (next !== 0) next = (last + r.se() + 256) % 256;
                        last = next === 0 ? last : next;
                    }
                }
            }
        }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) { r.bit(); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
    r.ue(); r.bit();
    const wMbs = r.ue() + 1, hMap = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit();
    r.bit();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const cux = chroma === 0 ? 1 : 2, cuy = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return {
        width: wMbs * 16 - (cl + cr) * cux,
        height: (2 - frameMbsOnly) * hMap * 16 - (ct + cb) * cuy
    };
}

// avcC → { sps, codec: 'avc1.PPCCLL', width, height }
function parseAvcC(avcc) {
    const spsLen = avcc.readUInt16BE(6);
    const sps = avcc.subarray(8, 8 + spsLen);
    const hex = (b) => b.toString(16).padStart(2, '0');
    const size = parseSps(sps);
    return { codec: 'avc1.' + hex(avcc[1]) + hex(avcc[2]) + hex(avcc[3]), width: size.width, height: size.height };
}

// HEVC SPS → ширина/высота (с учётом conformance window)
function parseHevcSps(nal) {
    const r = new BitReader(unescapeRbsp(nal.subarray(2)));
    r.bits(4);
    const maxSub = r.bits(3);
    r.bit();
    r.bits(96); // general profile_tier_level
    const profPresent = [], levelPresent = [];
    for (let i = 0; i < maxSub; i++) { profPresent.push(r.bit()); levelPresent.push(r.bit()); }
    if (maxSub > 0) for (let i = maxSub; i < 8; i++) r.bits(2);
    for (let i = 0; i < maxSub; i++) { if (profPresent[i]) r.bits(88); if (levelPresent[i]) r.bits(8); }
    r.ue();
    const chroma = r.ue();
    if (chroma === 3) r.bit();
    let width = r.ue(), height = r.ue();
    if (r.bit()) {
        const sx = chroma === 1 || chroma === 2 ? 2 : 1, sy = chroma === 1 ? 2 : 1;
        const l = r.ue(), rr = r.ue(), t = r.ue(), b = r.ue();
        width -= sx * (l + rr); height -= sy * (t + b);
    }
    return { width, height };
}

// hvcC → { codec: 'hvc1.1.6.L153.B0', width, height, bitDepth }
function parseHvcC(h) {
    const space = h[1] >> 6, tier = (h[1] >> 5) & 1, profile = h[1] & 0x1f;
    let compat = h.readUInt32BE(2), rev = 0;
    for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
    const cons = Array.from(h.subarray(6, 12));
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    let codec = 'hvc1.' + ['', 'A', 'B', 'C'][space] + profile + '.' + (rev >>> 0).toString(16).toUpperCase() +
        '.' + (tier ? 'H' : 'L') + h[12];
    cons.forEach((c) => { codec += '.' + c.toString(16).toUpperCase(); });
    let size = { width: 0, height: 0 };
    let off = 23;
    for (let a = 0, n = h[22]; a < n && off + 3 <= h.length; a++) {
        const type = h[off] & 0x3f, count = h.readUInt16BE(off + 1);
        off += 3;
        for (let i = 0; i < count; i++) {
            const len = h.readUInt16BE(off);
            if (type === 33 && !size.width) size = parseHevcSps(h.subarray(off + 2, off + 2 + len));
            off += 2 + len;
        }
    }
    return { codec, width: size.width, height: size.height, bitDepth: (h[17] & 7) + 8 };
}

/* ---------------- fMP4 ---------------- */

function box(type, ...parts) {
    const payload = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(payload.length + 8, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, payload]);
}

function full(type, version, flags, ...parts) {
    const vf = Buffer.alloc(4);
    vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
    return box(type, vf, ...parts);
}

function u32(...vals) { const b = Buffer.alloc(vals.length * 4); vals.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; }
function u16(...vals) { const b = Buffer.alloc(vals.length * 2); vals.forEach((v, i) => b.writeUInt16BE(v & 0xffff, i * 2)); return b; }
const MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

const TIMESCALE = 90000;

class Fmp4Muxer {
    // config — avcC (H.264) или hvcC (HEVC), fourcc — 'avc1' / 'hvc1'
    constructor(config, fps, fourcc) {
        this.config = config;
        this.fourcc = fourcc === 'hvc1' ? 'hvc1' : 'avc1';
        this.info = this.fourcc === 'hvc1' ? parseHvcC(config) : parseAvcC(config);
        this.minDur = Math.round(TIMESCALE / (fps || 60));
        this.maxDur = Math.round(TIMESCALE / 15);
        this.frameDur = this.minDur;
        this.lastDts = null;
        this.seq = 0;
        // Непрерывная шкала: кадры идут встык (разрыв в MSE = выброс кадров до ключевого).
        // Длительность кадра — сглаженный реальный интервал между кадрами, чтобы шкала шла
        // в ногу с реальным временем и при неравномерных кадрах окна (55 вместо 60 и т.п.).
        this.time = 0;
    }

    init() {
        const { width, height } = this.info;
        const ftyp = box('ftyp', 'isom', u32(512), 'isomiso6avc1mp41');
        const mvhd = full('mvhd', 0, 0, u32(0, 0, 1000, 0, 0x10000), u16(0x100, 0), u32(0, 0), MATRIX, Buffer.alloc(24), u32(2));
        const tkhd = full('tkhd', 0, 3, u32(0, 0, 1, 0, 0), Buffer.alloc(8), u16(0, 0, 0, 0), MATRIX, u32(width << 16, height << 16));
        const mdhd = full('mdhd', 0, 0, u32(0, 0, TIMESCALE, 0), u16(0x55c4, 0));
        const hdlr = full('hdlr', 0, 0, u32(0), 'vide', Buffer.alloc(12), 'PCStream\0');
        const entry = box(this.fourcc,
            Buffer.alloc(6), u16(1),                 // reserved, data_reference_index
            Buffer.alloc(16),                         // pre_defined/reserved
            u16(width, height), u32(0x480000, 0x480000, 0), u16(1),
            Buffer.alloc(32), u16(0x18, 0xffff),
            box(this.fourcc === 'hvc1' ? 'hvcC' : 'avcC', this.config));
        const stbl = box('stbl',
            full('stsd', 0, 0, u32(1), entry),
            full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
            full('stsz', 0, 0, u32(0, 0)), full('stco', 0, 0, u32(0)));
        const minf = box('minf', full('vmhd', 0, 1, u16(0, 0, 0, 0)),
            box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), stbl);
        const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
        const mvex = box('mvex', full('trex', 0, 0, u32(1, 1, 0, 0, 0)));
        return Buffer.concat([ftyp, box('moov', mvhd, trak, mvex)]);
    }

    // Один кадр → moof+mdat. Возвращает { data, key, time }
    fragment(frame) {
        this.seq++;
        if (this.lastDts != null) {
            const delta = (frame.dts - this.lastDts) * TIMESCALE / 1000; // dts FLV — в мс
            // паузы (окно не менялось) не учитываем, только живой темп
            if (delta > 0 && delta < TIMESCALE / 10) {
                this.frameDur = this.frameDur * 0.9 + delta * 0.1;
            }
        }
        this.lastDts = frame.dts;
        const dur = Math.round(Math.max(this.minDur, Math.min(this.maxDur, this.frameDur)));
        const flags = frame.key ? 0x02000000 : 0x01010000;
        const base = Buffer.alloc(8);
        base.writeBigUInt64BE(BigInt(this.time), 0);
        const build = (dataOffset) => box('moof',
            full('mfhd', 0, 0, u32(this.seq)),
            box('traf',
                full('tfhd', 0, 0x020000, u32(1)),
                full('tfdt', 1, 0, base),
                full('trun', 0, 0x000701, u32(1, dataOffset, dur, frame.data.length, flags))));
        const moofLen = build(0).length;
        const moof = build(moofLen + 8);
        const out = Buffer.concat([moof, box('mdat', frame.data)]);
        const t = this.time;
        this.time += dur;
        return { data: out, key: frame.key, time: t / TIMESCALE };
    }
}

module.exports = { FlvParser, Fmp4Muxer, parseAvcC, parseHvcC };
