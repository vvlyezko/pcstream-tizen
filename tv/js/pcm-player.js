/* Непрерывное воспроизведение PCM s16le стерео 48 кГц (AudioWorklet, звуковой поток).
   Кольцевой буфер + интерполяция Эрмита для пересчёта в частоту телевизора (44,1 кГц).
   Задержку держим мягкой подстройкой скорости (до ±0,5%, на слух незаметно) вместо прыжков. */
var IN_RATE = 48000;

class PcmPlayer extends AudioWorkletProcessor {
    constructor() {
        super();
        this.C = IN_RATE * 4;
        this.L = new Float32Array(this.C);
        this.R = new Float32Array(this.C);
        this.w = 0;              // записано кадров (всего)
        this.r = 0;              // позиция чтения (дробная)
        this.target = 0.3 * IN_RATE;
        this.playing = false;
        this.base = IN_RATE / sampleRate;
        this.fill = 0;
        this.under = 0;
        this.over = 0;
        this.adj = 0;
        this.lastReport = 0;
        var self = this;
        this.port.onmessage = function (e) {
            var m = e.data;
            if (m.reset) { self.w = 0; self.r = 0; self.fill = 0; self.playing = false; }
            if (m.target != null) self.target = Math.max(0.05, m.target) * IN_RATE;
            if (m.pcm) self.write(new Int16Array(m.pcm));
        };
    }

    write(p) {
        var n = p.length >> 1, C = this.C;
        if (this.w + n - this.r > C - 8) { this.r = this.w + n - this.target; this.over++; }
        for (var i = 0; i < n; i++) {
            var k = (this.w + i) % C;
            this.L[k] = p[2 * i] / 32768;
            this.R[k] = p[2 * i + 1] / 32768;
        }
        this.w += n;
    }

    process(inputs, outputs) {
        var out = outputs[0], oL = out[0], oR = out[1] || out[0], N = oL.length, i;
        var avail = this.w - this.r;
        if (!this.playing) {
            if (avail >= this.target) { this.playing = true; this.fill = avail; }
            else { for (i = 0; i < N; i++) { oL[i] = 0; oR[i] = 0; } return true; }
        }
        if (avail > this.target + 0.5 * IN_RATE) { this.r = this.w - this.target; this.over++; avail = this.target; this.fill = avail; }
        this.fill = this.fill * 0.995 + avail * 0.005;
        // большое устойчивое расхождение (старт, смена задержки) — один скачок вместо минут подстройки
        if (this.fill - this.target > 0.25 * IN_RATE) {
            this.r = this.w - this.target; this.fill = this.target; this.over++;
        } else if (this.target - this.fill > 0.25 * IN_RATE) {
            this.playing = false; this.fill = 0; this.under++; // докопим до цели тишиной
            for (i = 0; i < N; i++) { oL[i] = 0; oR[i] = 0; }
            return true;
        }
        var adj = (this.fill - this.target) / IN_RATE * 0.05; // 100 мс расхождения → 0,5%
        this.adj = adj = Math.max(-0.005, Math.min(0.005, adj));
        var step = this.base * (1 + adj), C = this.C, L = this.L, R = this.R;
        for (i = 0; i < N; i++) {
            if (this.w - this.r < 3) {
                for (; i < N; i++) { oL[i] = 0; oR[i] = 0; }
                this.playing = false;
                this.under++;
                break;
            }
            var ip = Math.floor(this.r), f = this.r - ip;
            var a = (ip + C - 1) % C, b = ip % C, c = (ip + 1) % C, d = (ip + 2) % C;
            oL[i] = hermite(L[a], L[b], L[c], L[d], f);
            oR[i] = hermite(R[a], R[b], R[c], R[d], f);
            this.r += step;
        }
        if (currentTime - this.lastReport >= 1) {
            this.lastReport = currentTime;
            this.port.postMessage({ fill: this.fill / IN_RATE, target: this.target / IN_RATE, adj: this.adj, under: this.under, over: this.over });
        }
        return true;
    }
}

function hermite(xm1, x0, x1, x2, t) {
    var c = (x1 - xm1) * 0.5, v = x0 - x1, w = c + v, a = w + v + (x2 - x0) * 0.5, b = w + a;
    return ((a * t - b) * t + c) * t + x0;
}

registerProcessor('pcm-player', PcmPlayer);
