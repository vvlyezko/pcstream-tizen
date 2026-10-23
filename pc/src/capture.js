'use strict';
/*
 * Захват и кодирование через FFmpeg (NVENC).
 *  - Экран: ddagrab (Desktop Duplication) — ровная частота кадров, родное разрешение.
 *  - Окно:  gfxcapture (Windows Graphics Capture) по HWND — работает даже под другими окнами.
 * HDR на ПК не трогаем: Windows сама отдаёт SDR-картинку при захвате.
 * Выход — FLV (каждый кадр сразу и с размером), дальше Fmp4Muxer.
 */

const { spawn } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');
const { FlvParser, Fmp4Muxer } = require('./media');

function ffmpegPath() {
    // в собранном приложении bin лежит рядом с ресурсами
    const base = process.resourcesPath && !/node_modules[\\/]electron/.test(process.resourcesPath)
        ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'bin');
    return path.join(base, 'ffmpeg.exe');
}

function buildArgs(o) {
    const fps = o.fps || 60;
    const br = o.bitrate || 20;
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    let input;
    if (o.kind === 'window') {
        // окно: res — высота кадра 16:9, окно вписывается с сохранением пропорций
        const size = o.res ? ':width=' + even(o.res * 16 / 9) + ':height=' + o.res : ':width=-2:height=-2';
        input = 'gfxcapture=hwnd=' + o.hwnd + ':max_framerate=' + fps +
            ':capture_cursor=' + (o.cursor ? 1 : 0) + ':resize_mode=scale_aspect' + size;
    } else if (o.res && o.srcH && o.res < o.srcH) {
        // уменьшенное разрешение экрана: ddagrab + scale_d3d11 в этой сборке не работает,
        // а gfxcapture масштабирует весь монитор прямо на GPU
        input = 'gfxcapture=monitor_idx=' + (o.output || 0) + ':max_framerate=' + fps +
            ':capture_cursor=' + (o.cursor ? 1 : 0) + ':resize_mode=scale_aspect:scale_mode=bicubic' +
            ':width=' + even(o.srcW * o.res / o.srcH) + ':height=' + o.res;
    } else {
        input = 'ddagrab=output_idx=' + (o.output || 0) + ':framerate=' + fps + ':draw_mouse=' + (o.cursor ? 1 : 0);
    }
    // HEVC по умолчанию: MSE телевизора (Q95T) декодирует H.264 только до 1080p,
    // а HEVC тянет и 1440p60, и 4K60
    const hevc = o.codec !== 'h264';
    return [
        '-hide_banner', '-loglevel', 'warning', '-nostats',
        '-f', 'lavfi', '-i', input,
        '-c:v', hevc ? 'hevc_nvenc' : 'h264_nvenc', '-preset', 'p2', '-tune', 'ull', '-zerolatency', '1',
        '-rc', 'cbr', '-b:v', br + 'M', '-maxrate', br + 'M', '-bufsize', Math.max(2, Math.round(br / 3)) + 'M',
        '-g', String(fps), '-bf', '0', '-profile:v', hevc ? 'main' : 'high', '-forced-idr', '1',
        '-f', 'flv', '-flvflags', 'no_duration_filesize', 'pipe:1'
    ];
}

class Capture extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.proc = null;
        this.muxer = null;
        this.log = '';
    }

    start() {
        const args = buildArgs(this.opts);
        const parser = new FlvParser();
        parser.on('config', (config, fourcc) => {
            this.muxer = new Fmp4Muxer(config, this.opts.fps, fourcc);
            const info = this.muxer.info;
            this.emit('init', this.muxer.init(), {
                codec: info.codec, width: info.width, height: info.height,
                fps: this.opts.fps, label: this.opts.label, kind: this.opts.kind
            });
        });
        parser.on('frame', (f) => { if (this.muxer) this.emit('fragment', this.muxer.fragment(f)); });

        this.proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc.stdout.on('data', (d) => {
            try { parser.push(d); } catch (e) { this.emit('error', e); this.stop(); }
        });
        this.proc.stderr.on('data', (d) => { this.log = (this.log + d.toString()).slice(-4000); });
        this.proc.on('exit', (code) => {
            const wasRunning = !!this.proc;
            this.proc = null;
            if (wasRunning) this.emit('exit', code, this.log.trim());
        });
        this.proc.on('error', (e) => this.emit('error', e));
    }

    stop() {
        const p = this.proc;
        this.proc = null;
        if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
    }
}

module.exports = { Capture, buildArgs, ffmpegPath };
