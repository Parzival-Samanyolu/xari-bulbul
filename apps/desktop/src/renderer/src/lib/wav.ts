import { encodeWav, WHISPER_SAMPLE_RATE } from '@harness/core/wav'

/**
 * A MediaRecorder clip (WebM/Opus) → 16 kHz mono WAV for whisper.cpp, with Web Audio only.
 * Decoding into a 16 kHz context resamples; rendering through a one-channel context mixes down.
 */
export async function recordingToWav(blob: Blob): Promise<Uint8Array> {
  const decoded = await new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer())
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE)), WHISPER_SAMPLE_RATE)
  const source = ctx.createBufferSource()
  source.buffer = decoded
  source.connect(ctx.destination)
  source.start()
  const mono = await ctx.startRendering()
  return encodeWav(mono.getChannelData(0), WHISPER_SAMPLE_RATE)
}
