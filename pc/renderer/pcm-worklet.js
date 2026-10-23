/* Снимает звук блоками по 20 мс и отдаёт PCM s16le стерео 48 кГц. */
class PcmTap extends AudioWorkletProcessor {
    constructor() {
        super();
        this.frames = 960; // 20 мс при 48 кГц
        this.buf = new Int16Array(this.frames * 2);
        this.n = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input.length) return true;
        const L = input[0], R = input[1] || input[0];
        for (let i = 0; i < L.length; i++) {
            const l = Math.max(-1, Math.min(1, L[i]));
            const r = Math.max(-1, Math.min(1, R[i]));
            this.buf[this.n * 2] = l < 0 ? l * 32768 : l * 32767;
            this.buf[this.n * 2 + 1] = r < 0 ? r * 32768 : r * 32767;
            if (++this.n === this.frames) {
                this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
                this.buf = new Int16Array(this.frames * 2);
                this.n = 0;
            }
        }
        return true;
    }
}
registerProcessor('pcm-tap', PcmTap);
