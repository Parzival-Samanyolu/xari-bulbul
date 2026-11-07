// Hands-free listening: one open microphone, and a simple voice-activity detector that records
// one utterance at a time (it starts when you speak and ends after a short pause).

/** Opus in WebM is what Chromium records; the fallbacks are for other engines. */
export function recorderType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(t)) return t
  return ''
}

export interface ListenOptions {
  signal: AbortSignal
  /** Longest utterance; it ends there even mid-sentence. */
  maxMs: number
  /** Quiet this long after speech ends the utterance. */
  pauseMs?: number
  /** Reports the input level (0–1) about 20 times a second, for the meter. */
  onLevel?: (level: number) => void
  /** Called once speech is detected. */
  onSpeech?: () => void
}

/** `listen()` ran before `open()` or after `close()`; the caller shows `chat.voice.micNotOpen`. */
export class MicNotOpenError extends Error {
  constructor() {
    super('The microphone is not open.')
    this.name = 'MicNotOpenError'
  }
}

export class Listener {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  /** Background noise, tracked while nobody speaks. */
  private floor = 0.01

  async open(): Promise<void> {
    if (this.stream) return
    // Echo cancellation keeps the bot's own voice out, mostly; we also don't listen while it speaks.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    this.ctx = new AudioContext()
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    src.connect(this.analyser)
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => {})
    this.stream = null
    this.ctx = null
    this.analyser = null
  }

  private level(buf: Float32Array<ArrayBuffer>): number {
    this.analyser!.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    return Math.sqrt(sum / buf.length)
  }

  /** Records until one utterance ends; null when aborted. Silence before speaking is dropped. */
  listen(opts: ListenOptions): Promise<Blob | null> {
    const stream = this.stream
    const analyser = this.analyser
    if (!stream || !analyser) return Promise.reject(new MicNotOpenError())
    const pauseMs = opts.pauseMs ?? 1300
    return new Promise((resolve) => {
      const type = recorderType()
      let recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
      let chunks: Blob[] = []
      let speaking = false
      let loud = 0
      let speechAt = 0
      let lastLoud = 0
      let idleSince = Date.now()
      let done = false
      const buf = new Float32Array(analyser.fftSize)
      const begin = () => {
        chunks = []
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
        recorder.start(250)
      }
      const finish = (keep: boolean) => {
        if (done) return
        done = true
        clearInterval(timer)
        opts.signal.removeEventListener('abort', onAbort)
        recorder.onstop = () => resolve(keep && chunks.length ? new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' }) : null)
        if (recorder.state !== 'inactive') recorder.stop()
        else resolve(null)
      }
      const onAbort = () => finish(false)
      opts.signal.addEventListener('abort', onAbort)
      begin()
      const timer = setInterval(() => {
        const now = Date.now()
        const rms = this.level(buf)
        const threshold = Math.max(0.018, this.floor * 2.8)
        opts.onLevel?.(Math.min(1, rms / 0.12))
        if (!speaking) {
          // Learn the room's noise while it's quiet.
          if (rms < threshold) this.floor = this.floor * 0.95 + rms * 0.05
          loud = rms >= threshold ? loud + 1 : 0
          if (loud >= 3) {
            speaking = true
            speechAt = now
            lastLoud = now
            opts.onSpeech?.()
          } else if (now - idleSince > 15_000) {
            // Nothing said for a while: start over so the recording stays small.
            idleSince = now
            const old = recorder
            old.ondataavailable = null
            old.onstop = null
            if (old.state !== 'inactive') old.stop()
            recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
            begin()
          }
          return
        }
        if (rms >= threshold * 0.8) lastLoud = now
        if (now - lastLoud >= pauseMs || now - speechAt >= opts.maxMs) finish(true)
      }, 50)
    })
  }
}
