/**
 * AudioWorklet processor — runs on the audio thread.
 * Accumulates Float32 mic samples into 4096-sample chunks,
 * converts to Int16 PCM, and posts the raw ArrayBuffer to the main thread.
 * We send the browser's native sample rate to Deepgram (no downsampling needed).
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = new Float32Array(4096)
    this._idx = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this._buf[this._idx++] = channel[i]

      if (this._idx >= this._buf.length) {
        const pcm16 = new Int16Array(this._buf.length)
        for (let j = 0; j < this._buf.length; j++) {
          const s = Math.max(-1, Math.min(1, this._buf[j]))
          pcm16[j] = s < 0 ? s * 32768 : s * 32767
        }
        // Transfer ownership of the buffer — zero-copy send
        this.port.postMessage(pcm16.buffer, [pcm16.buffer])
        this._idx = 0
      }
    }

    return true
  }
}

registerProcessor('audio-processor', AudioProcessor)
