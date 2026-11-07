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

/* HDR: захват в scRGB (16 бит, линейный свет, 1.0 = 80 нит) → libplacebo на видеокарте
   (Vulkan): PQ + BT.2020, 10 бит, при необходимости уменьшение → HEVC Main10 с HDR10-метками.
   bin/scrgb.hook поправляет масштаб: libplacebo считает линейный 1.0 = 203 нит.
   zscale не годится: на этой сборке обрезает всё ярче 1.0 (HDR пропадает). */
function hdrArgs(o, fps, br) {
    const input = o.kind === 'window'
        ? 'gfxcapture=hwnd=' + o.hwnd + ':max_framerate=' + fps + ':capture_cursor=' + (o.cursor ? 1 : 0) + ':output_fmt=16bit'
        : 'ddagrab=output_idx=' + (o.output || 0) + ':framerate=' + fps + ':draw_mouse=' + (o.cursor ? 1 : 0) + ':output_fmt=16bit';
    // уменьшаем только если кадр выше заданного (запятые в выражениях экранируются для графа фильтров)
    const size = o.res ? ':w=trunc(iw*min(ih\\,' + o.res + ')/ih/2)*2:h=trunc(min(ih\\,' + o.res + ')/2)*2' : '';
    const vf = 'hwdownload,format=rgbaf16le,setparams=color_primaries=bt709:color_trc=linear:colorspace=gbr:range=pc,' +
        'hwupload,libplacebo=custom_shader_path=scrgb.hook:format=p010le:colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv' + size +
        ',hwdownload,format=p010le';
    return [
        '-hide_banner', '-loglevel', 'warning', '-nostats',
        '-init_hw_device', 'vulkan=vk', '-filter_hw_device', 'vk',
        '-f', 'lavfi', '-i', input, '-vf', vf,
        '-c:v', 'hevc_nvenc', '-preset', 'p2', '-tune', 'ull', '-zerolatency', '1',
        '-rc', 'cbr', '-b:v', br + 'M', '-maxrate', br + 'M', '-bufsize', Math.max(2, Math.round(br / 3)) + 'M',
        '-g', String(fps), '-bf', '0', '-profile:v', 'main10', '-forced-idr', '1',
        '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_range', 'tv',
        '-f', 'flv', '-flvflags', 'no_duration_filesize', 'pipe:1'
    ];
}

function buildArgs(o) {
    const fps = o.fps || 60;
    const br = o.bitrate || 20;
    if (o.hdr) return hdrArgs(o, fps, br);
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
                fps: this.opts.fps, label: this.opts.label, kind: this.opts.kind, hdr: !!this.opts.hdr
            });
        });
        parser.on('frame', (f) => { if (this.muxer) this.emit('fragment', this.muxer.fragment(f)); });

        // cwd = bin: там шейдер scrgb.hook (путь без «C:» — двоеточие ломает разбор параметров фильтра)
        this.proc = spawn(ffmpegPath(), args, { windowsHide: true, cwd: path.dirname(ffmpegPath()), stdio: ['ignore', 'pipe', 'pipe'] });
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
