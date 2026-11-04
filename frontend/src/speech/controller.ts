import { apiFetch } from '../api'
import type { ServerEvent } from '../types'
import workletUrl from './capture-worklet.js?url'
import { pcm16, wakeCommand } from './audio'

export interface SpeechState { enabled: boolean; listening: boolean; tts: boolean; status: string; active?: boolean; mode?: 'browser' | 'local'; phase?: string; session_id?: string }
const WAITING = '说「你好，布鲁 / Hello Blue」叫我，或在这里输入…'
const LISTENING = '我在听，你说吧…'
const STOPPED = '想说话时，点一下麦克风就好'
const LAST_SENTENCE = '麦克风关好啦，最后一句让我听完…'
const ACTIVE_MS = 60_000
const normalized = (text: string) => text.toLowerCase().replace(/[\s，。！？、,.!?：:；;]/g, '')

export class SpeechController {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private capture: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private gain: GainNode | null = null
  private chunks: Float32Array[] = []
  private lead: Float32Array[] = []
  private samples = 0
  private voiced = 0
  private lastSound = 0
  private activeUntil = 0
  private engaged = false
  private processing = false
  private confirming = false
  private utteranceActive = false
  private starting = false
  private stopped = false
  private autoAttempted = false
  private recognizing = false
  private playing = false
  private closed = false
  private epoch = 0
  private micEpoch = 0
  private playbackEpoch = 0
  private speechSource: AudioBufferSourceNode | null = null
  private inputAbort = new AbortController()
  private outputAbort = new AbortController()
  private recordings: { audio: ArrayBuffer; active: boolean; epoch: number; echo: string }[] = []
  private speechQueue: string[] = []
  private text = new Map<string, string>()
  private spoken = new Set<string>()
  private lastPlayback = ''
  private echoUntil = 0
  private state: SpeechState = { enabled: false, listening: false, tts: false, status: '' }

  private local = false
  private ready: Promise<void> | null = null

  private submit: (text: string) => void
  private notice: (text: string) => void
  private update: (state: SpeechState) => void
  private partial: (text: string) => void
  private wake: () => void
  constructor(submit: (text: string) => void, notice: (text: string) => void,
    update: (state: SpeechState) => void, partial: (text: string) => void, wake: () => void) {
    this.submit = submit; this.notice = notice; this.update = update; this.partial = partial; this.wake = wake
  }

  async unlock() {
    await this.initialize()
    if (this.local || this.closed) return
    this.context ??= new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
  }

  initialize() {
    this.ready ??= apiFetch('/api/speech').then(async response => {
      if (!response.ok) throw new Error('语音状态暂不可用')
      const data = await response.json()
      if (!this.closed && !this.local && data.mode === 'local' && data.local) this.localState(data.local)
    }).catch(() => { this.ready = null })
    return this.ready
  }

  private localState(state: Omit<SpeechState, 'listening'>) {
    this.local = true
    this.state = { enabled: state.enabled, tts: state.tts, status: state.status, active: state.active, listening: !!state.active && state.phase === 'listening', phase: state.phase, session_id: state.session_id ?? this.state.session_id, mode: 'local' }
    this.update(this.state)
  }

  private async control(action: string) {
    try {
      const response = await apiFetch('/api/speech/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, session_id: this.state.session_id }),
      })
      if (!response.ok) throw new Error('本地语音未连接')
      if (!this.closed) this.localState(await response.json())
    } catch { if (!this.closed) this.report('本地语音未连接，请检查后端服务') }
  }

  private isActive() {
    return this.engaged && (this.processing || this.confirming || this.playing || this.recognizing || Date.now() < this.activeUntil)
  }

  private report(status: string) {
    if (!this.closed) {
      this.state = { ...this.state, listening: this.local ? this.state.listening : this.state.enabled && this.isActive(), status }
      this.update(this.state)
    }
  }

  private readyStatus() { return !this.state.enabled ? STOPPED : this.isActive() ? LISTENING : WAITING }

  activate() {
    if (this.local) return
    this.engaged = true
    this.activeUntil = Date.now() + ACTIVE_MS
    if (this.state.enabled) this.report(LISTENING)
  }

  async autoStart() {
    await this.initialize()
    if (this.local) return
    if (this.autoAttempted || this.stopped || this.closed) return
    this.autoAttempted = true
    await this.mic(true)
  }

  async toggle() {
    await this.initialize()
    if (this.local) { await this.mic(); return }
    if (this.starting || this.state.enabled && this.isActive()) this.stopListening()
    else if (this.state.enabled) this.activate()
    else await this.mic()
  }

  async mic(automatic = false) {
    await this.initialize()
    if (this.closed || this.starting) return
    if (this.local) {
      if (automatic) return
      this.starting = true
      try { await this.control('toggle') } finally { this.starting = false }
      return
    }
    this.stopped = false
    if (this.stream) { if (!automatic) this.activate(); return }
    const generation = ++this.micEpoch
    this.starting = true
    try {
      const status = await apiFetch('/api/speech').then(r => r.json())
      if (generation !== this.micEpoch || this.closed) return
      if (!status.configured) { this.report('语音还没准备好，先打字也可以'); return }
      this.report('稍等，麦克风马上就好…')
      // On browsers requiring a gesture, the existing microphone is the retry entry.
      this.context ??= new AudioContext()
      if (automatic && this.context.state === 'suspended') {
        this.autoAttempted = false; this.report('点一下麦克风，就能和我说话啦'); return
      }
      await this.unlock()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (this.closed || generation !== this.micEpoch) { stream.getTracks().forEach(t => t.stop()); return }
      this.stream = stream
      await this.context.audioWorklet.addModule(workletUrl)
      if (this.closed || generation !== this.micEpoch) return
      this.capture = new AudioWorkletNode(this.context, 'bluesword-capture')
      this.source = this.context.createMediaStreamSource(stream)
      this.gain = this.context.createGain(); this.gain.gain.value = 0
      this.source.connect(this.capture).connect(this.gain).connect(this.context.destination)
      this.capture.port.onmessage = (event: MessageEvent<Float32Array>) => this.frame(event.data)
      this.state = { ...this.state, enabled: true }
      if (!automatic) this.activate()
      this.report(this.readyStatus())
    } catch {
      if (generation === this.micEpoch && !this.closed) {
        this.releaseMic()
        this.report('点一下麦克风，就能和我说话啦')
      }
    } finally { if (generation === this.micEpoch) this.starting = false }
  }

  private releaseMic() {
    this.micEpoch++; this.starting = false
    this.stream?.getTracks().forEach(track => track.stop())
    if (this.capture) this.capture.port.onmessage = null
    this.capture?.disconnect(); this.source?.disconnect(); this.gain?.disconnect()
    this.stream = null; this.capture = null; this.source = null; this.gain = null
    this.state = { ...this.state, enabled: false }
  }

  stopListening() {
    if (this.local) { void this.control('pause'); return }
    this.stopped = true
    // Flush before releasing the stream. Already submitted ASR survives this operation.
    this.finish()
    this.releaseMic(); this.clearAudio()
    this.report(this.recognizing || this.recordings.length ? LAST_SENTENCE : STOPPED)
  }

  setTts(enabled: boolean) {
    if (this.local) { void this.control(enabled ? 'tts_on' : 'tts_off'); return }
    this.state = { ...this.state, tts: enabled }
    if (!enabled) this.stopPlayback()
    this.update(this.state)
  }

  private clearAudio() { this.chunks = []; this.lead = []; this.samples = 0; this.voiced = 0; this.lastSound = 0 }

  private frame(frame: Float32Array) {
    if (!this.stream || this.closed) return
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length)
    const now = Date.now()
    if (rms > 0.018) {
      if (!this.lastSound) { this.utteranceActive = this.isActive(); this.chunks = [...this.lead]; this.samples = this.lead.reduce((n, part) => n + part.length, 0) }
      this.lastSound = now; this.voiced += frame.length
      // Sustained speech can interrupt output without invalidating the recording.
      if (this.playing && this.voiced >= this.context!.sampleRate * 0.12) {
        this.activate()
        this.stopPlayback()
      }
    }
    if (this.lastSound) {
      this.chunks.push(frame); this.samples += frame.length
      if (now - this.lastSound > 850 || this.samples / this.context!.sampleRate > 25) this.finish()
    } else {
      this.lead.push(frame)
      if (this.lead.length > Math.ceil(this.context!.sampleRate * 0.15 / frame.length)) this.lead.shift()
      if (!this.isActive() && !this.recognizing && this.state.status !== WAITING) {
        this.engaged = false
        this.report(WAITING)
      }
    }
  }

  private finish() {
    if (!this.context || !this.chunks.length) return
    const audio = pcm16(this.chunks, this.context.sampleRate)
    const voiced = this.voiced
    this.clearAudio()
    if (audio.byteLength < 6400 || voiced / this.context.sampleRate < 0.08) return
    if (this.recordings.length >= 3) { this.notice('正在听清前面的话，稍等一下再说吧。'); return }
    this.recordings.push({ audio, active: this.utteranceActive, epoch: this.epoch,
      echo: Date.now() < this.echoUntil ? normalized(this.lastPlayback) : '' })
    void this.recognizeNext()
  }

  private async recognizeNext() {
    if (this.recognizing || this.closed) return
    const recording = this.recordings.shift()
    if (!recording) return
    // Recognition must not extend an already expired conversation by itself.
    if (!this.isActive()) this.engaged = false
    this.recognizing = true
    this.report(this.state.enabled ? (this.engaged ? '稍等，让我听清楚…' : WAITING) : LAST_SENTENCE)
    try {
      const response = await apiFetch('/api/speech/recognize', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: recording.audio, signal: this.inputAbort.signal })
      if (!response.ok) throw new Error('识别未完成')
      const data = await response.json() as { text: string }
      if (recording.epoch !== this.epoch || this.closed) return
      const heard = normalized(data.text)
      const echo = recording.echo && (heard === recording.echo || heard.length >= 6 && recording.echo.includes(heard))
      if (heard && !echo) {
        const command = wakeCommand(data.text)
        if (command !== null || recording.active || this.isActive()) {
          const text = command ?? data.text.trim()
          this.activate()
          if (text) { this.stopPlayback(); this.partial(''); this.submit(text) }
          else if (command !== null) { this.wake(); this.report('我在，接着说吧') }
        }
      }
    } catch {
      if (recording.epoch === this.epoch && !this.closed) this.notice('这句话暂时没听清，可以再说一次或打字。')
    } finally {
      if (recording.epoch === this.epoch) {
        this.recognizing = false
        if (this.state.status !== '我在，接着说吧' || !this.state.enabled) this.report(this.readyStatus())
        void this.recognizeNext()
        void this.playNext()
      }
    }
  }

  onEvent(event: ServerEvent) {
    if (event.type === 'voice_status') { this.localState(event); return }
    if (event.type === 'assistant_abort') {
      this.text.delete(event.id)
      this.spoken.add(event.id) // Late deltas/end must never enqueue the failed attempt.
      return
    }
    if (this.local) {
      if (event.type === 'device' && !event.online) this.report('连接中 · 本地监听由后端运行')
      return
    }
    if (event.type === 'phase') {
      const wasProcessing = this.processing
      this.processing = event.phase === 'thinking'
      if (wasProcessing && !this.processing && this.engaged) this.activeUntil = Date.now() + ACTIVE_MS
    }
    if (event.type === 'confirm_closed') {
      this.confirming = false; this.text.clear(); this.stopPlayback()
      if (this.engaged) this.activeUntil = Date.now() + ACTIVE_MS
    }
    if (event.type === 'confirm_request' || event.type === 'confirm_refresh') {
      this.confirming = true
      this.activate()
      if (event.type === 'confirm_request') for (const id of this.text.keys()) this.enqueue(id)
    }
    if (event.type === 'assistant_start') { this.processing = true; this.text.set(event.id, '') }
    if (event.type === 'assistant_delta' && !this.spoken.has(event.id)) this.text.set(event.id, (this.text.get(event.id) ?? '') + event.text)
    if (event.type === 'assistant_end') { this.processing = false; if (this.engaged) this.activeUntil = Date.now() + ACTIVE_MS; this.enqueue(event.id) }
    if (event.type === 'device' && !event.online) this.reset()
    if (event.type === 'device' && event.online) void this.autoStart()
  }

  private enqueue(id: string) {
    const text = this.text.get(id)?.trim()
    if (!text || this.spoken.has(id)) return
    this.spoken.add(id); this.text.delete(id)
    if (this.spoken.size > 100) this.spoken.delete(this.spoken.values().next().value!)
    if (!this.state.tts || !this.context) return
    this.speechQueue.push(text.slice(0, 1000))
    void this.playNext()
  }

  private async playNext() {
    if (this.playing || !this.speechQueue.length || this.closed || this.lastSound || this.recognizing) return
    const text = this.speechQueue.shift()!
    const generation = this.playbackEpoch
    this.playing = true
    try {
      const response = await apiFetch('/api/speech/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: this.outputAbort.signal })
      if (!response.ok) throw new Error('播报暂不可用')
      const buffer = await this.context!.decodeAudioData(await response.arrayBuffer())
      if (this.closed || generation !== this.playbackEpoch || !this.state.tts) return
      this.lastPlayback = text
      this.echoUntil = Date.now() + (buffer.duration + 3) * 1000
      this.activeUntil = this.echoUntil + ACTIVE_MS
      await this.unlock()
      await new Promise<void>(resolve => {
        const source = this.context!.createBufferSource()
        this.speechSource = source; source.buffer = buffer
        source.connect(this.context!.destination); source.onended = () => { source.disconnect(); resolve() }; source.start()
      })
    } catch {
      if (!this.closed && generation === this.playbackEpoch) this.report('文字已显示，播报暂时没接上')
    } finally {
      if (generation === this.playbackEpoch) {
        this.playing = false; this.speechSource = null
        this.activeUntil = Date.now() + ACTIVE_MS
        void this.playNext()
      }
    }
  }

  private stopPlayback() {
    this.playbackEpoch++
    this.outputAbort.abort(); this.outputAbort = new AbortController()
    this.speechSource?.stop(); this.speechSource = null
    this.speechQueue = []; this.playing = false
  }

  interrupt() { if (!this.local) this.stopPlayback() }
  reset() {
    if (this.local) { this.partial(''); return }
    this.epoch++; this.inputAbort.abort(); this.inputAbort = new AbortController()
    this.recordings = []; this.recognizing = false; this.clearAudio(); this.stopPlayback()
    this.text.clear(); this.activeUntil = 0; this.engaged = false; this.processing = false; this.confirming = false; this.partial(''); this.report(this.readyStatus())
  }
  close() { this.closed = true; if (!this.local) { this.reset(); this.releaseMic() }; void this.context?.close() }
}
