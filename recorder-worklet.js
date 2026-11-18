// AudioWorklet that captures mono PCM from the microphone on the audio thread.
// Each batch is posted with the context time of its first sample so recordings
// can be placed on the timeline sample-accurately.
class RnbRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.fill = 0;
    this.t0 = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') {
        this.fill = 0;
        this.recording = true;
      } else if (e.data === 'stop') {
        this.recording = false;
        if (this.fill > 0) this.flush();
        this.port.postMessage({ type: 'done' });
      }
    };
  }

  flush() {
    const samples = this.buf.slice(0, this.fill);
    this.port.postMessage({ type: 'data', time: this.t0, samples }, [samples.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    if (!this.recording) return true;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      if (this.fill === 0) this.t0 = currentTime + i / sampleRate;
      const n = Math.min(ch.length - i, this.size - this.fill);
      this.buf.set(ch.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.size) this.flush();
    }
    return true;
  }
}

registerProcessor('rnb-recorder', RnbRecorder);
