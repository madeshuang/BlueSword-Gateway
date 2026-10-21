class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = []; this.position = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) this.buffer.push(sample);
    const step = sampleRate / 16000;
    const values = [];
    while (this.position + 1 < this.buffer.length) {
      const i = Math.floor(this.position), f = this.position - i;
      const value = this.buffer[i] * (1-f) + this.buffer[i+1] * f;
      values.push(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)));
      this.position += step;
    }
    const consumed = Math.min(Math.floor(this.position), this.buffer.length);
    this.buffer.splice(0, consumed); this.position -= consumed;
    if (values.length) { const pcm = new Int16Array(values); this.port.postMessage(pcm.buffer, [pcm.buffer]); }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
