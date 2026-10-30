// Reading replies aloud. One Speaker for the whole page, so only one thing plays at a time.
// The system voice is the page's speechSynthesis; OpenAI chunks come from the main process
// as MP3 and play through an <audio> element, fetching the next chunk while one plays.

import { useEffect, useRef } from 'react'
import { prepareSpeech } from '@harness/core/speech'
import type { AppState, Settings, SpeechAudio } from '../../../shared/ipc'
import { api } from './api'

type TtsSettings = Settings['voice']['tts']
export type SpeechNotice = (level: 'info' | 'warn' | 'error', text: string) => void

const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The page's voices; Chromium fills the list asynchronously, so wait briefly for `voiceschanged`. */
export function systemVoices(): Promise<SpeechSynthesisVoice[]> {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  if (!synth) return Promise.resolve([])
  const now = synth.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener('voiceschanged', done)
      clearTimeout(timer)
      resolve(synth.getVoices())
    }
    const timer = setTimeout(done, 2000)
    synth.addEventListener('voiceschanged', done)
  })
}

class Speaker {
  private gen = 0
  private current: string | null = null
  private listeners = new Set<() => void>()
  private audio: HTMLAudioElement | null = null
  private url: string | null = null
  private endPlay: (() => void) | null = null
  /** `voice.tts` of the current settings; set by useSpeech on every render. */
  settings: TtsSettings | null = null
  onNotice: SpeechNotice | null = null

  /** The id being read, or null. */
  get playing() {
    return this.current
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private setCurrent(id: string | null) {
    if (this.current === id) return
    this.current = id
    for (const fn of this.listeners) fn()
  }

  stop = () => {
    this.gen++
    window.speechSynthesis?.cancel()
    this.releaseAudio()
    this.setCurrent(null)
  }

  private releaseAudio() {
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio = null
    }
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
    const end = this.endPlay
    this.endPlay = null
    end?.()
  }

  toggle(id: string, markdown: string) {
    if (this.current === id) this.stop()
    else void this.speak(id, markdown)
  }

  /** Stops whatever is playing and reads `markdown` (code blocks and links shortened). */
  async speak(id: string, markdown: string, opts: { notice?: SpeechNotice } = {}): Promise<void> {
    this.stop()
    const settings = this.settings
    if (!settings || settings.provider === 'off') return
    const chunks = prepareSpeech(markdown)
    if (!chunks.length) return
    const gen = this.gen
    const notice: SpeechNotice = (level, text) => (opts.notice ?? this.onNotice)?.(level, text)
    this.setCurrent(id)
    try {
      if (settings.provider === 'system') await this.system(chunks, settings.voice, settings.rate, gen)
      else await this.remote(chunks, gen)
    } catch (e) {
      if (gen === this.gen) notice('error', `Couldn't read this aloud: ${errorText(e)}`)
    } finally {
      if (gen === this.gen) {
        this.releaseAudio()
        this.setCurrent(null)
      }
    }
  }

  private async system(chunks: string[], voiceId: string | null, rate: number, gen: number): Promise<void> {
    const synth = window.speechSynthesis
    if (!synth) throw new Error('this system has no speech voice')
    const voices = voiceId ? await systemVoices() : []
    if (gen !== this.gen) return
    const voice = voiceId ? (voices.find((v) => v.voiceURI === voiceId) ?? voices.find((v) => v.name === voiceId) ?? null) : null
    await new Promise<void>((resolve) => {
      let left = chunks.length
      const one = () => --left <= 0 && resolve()
      for (const text of chunks) {
        const u = new SpeechSynthesisUtterance(text)
        if (voice) {
          u.voice = voice
          u.lang = voice.lang
        }
        u.rate = rate
        u.onend = one
        // cancel() (stop) ends every queued utterance with an error, which also resolves.
        u.onerror = one
        synth.speak(u)
      }
    })
  }

  private async remote(chunks: string[], gen: number): Promise<void> {
    const fetchChunk = (text: string) => {
      const p = api.tts.synthesize(text)
      p.catch(() => {}) // awaited below; this only keeps an early failure from being "unhandled"
      return p
    }
    let next = fetchChunk(chunks[0])
    for (let i = 0; i < chunks.length; i++) {
      const clip: SpeechAudio = await next
      if (gen !== this.gen) return
      if (i + 1 < chunks.length) next = fetchChunk(chunks[i + 1])
      await this.play(clip, gen)
      if (gen !== this.gen) return
    }
  }

  private play(clip: SpeechAudio, gen: number): Promise<void> {
    return new Promise((resolve) => {
      this.releaseAudio()
      if (gen !== this.gen) return resolve()
      this.url = URL.createObjectURL(new Blob([clip.audio as Uint8Array<ArrayBuffer>], { type: clip.mediaType }))
      const audio = new Audio(this.url)
      audio.playbackRate = clip.playbackRate
      this.audio = audio
      this.endPlay = resolve
      const end = () => {
        if (this.audio === audio) this.releaseAudio()
        else resolve()
      }
      audio.onended = end
      audio.onerror = end
      audio.play().catch(end)
    })
  }
}

export const speaker = new Speaker()

/**
 * Wires the speaker to the app: keeps its settings current, reads each finished reply in the
 * chat on screen when "Read responses aloud" is on, and stops on typing in the message box,
 * sending (a turn starting) or Esc.
 */
export function useSpeech(app: AppState | null, notify: SpeechNotice) {
  const tts = app?.settings.voice.tts ?? null
  speaker.settings = tts
  speaker.onNotice = notify
  const shown = useRef<string | undefined>(undefined)
  shown.current = app?.session?.meta.id
  const readAloud = useRef(false)
  readAloud.current = !!tts && tts.readAloud && tts.provider !== 'off'

  useEffect(() => {
    if (tts?.provider === 'off') speaker.stop()
  }, [tts?.provider])

  useEffect(() => {
    /** The last assistant text of each chat's running turn. */
    const replies = new Map<string, { index: number; text: string }>()
    const offEvents = api.onEvent((e) => {
      if (e.type !== 'agent') return
      const ev = e.event
      if (ev.type === 'turn_start') {
        replies.delete(e.sessionId)
        if (e.sessionId === shown.current) speaker.stop()
      } else if (ev.type === 'message' && ev.message.role === 'assistant' && ev.message.content.trim()) {
        replies.set(e.sessionId, { index: ev.index, text: ev.message.content })
      } else if (ev.type === 'turn_end') {
        const reply = replies.get(e.sessionId)
        replies.delete(e.sessionId)
        if (reply && ev.reason === 'done' && readAloud.current && e.sessionId === shown.current) void speaker.speak(`${e.sessionId}:${reply.index}`, reply.text)
      }
    })
    const onKey = (k: KeyboardEvent) => {
      if (k.key === 'Escape' && speaker.playing) speaker.stop()
    }
    const onInput = (ev: Event) => {
      if (speaker.playing && (ev.target as Element | null)?.closest?.('.composer')) speaker.stop()
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('input', onInput, true)
    return () => {
      offEvents()
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('input', onInput, true)
      speaker.stop()
    }
  }, [])
}
