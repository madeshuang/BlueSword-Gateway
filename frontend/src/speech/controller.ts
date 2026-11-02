import { apiFetch } from '../api'
import type { ServerEvent } from '../types'
import workletUrl from './capture-worklet.js?url'
import { pcm16, wakeCommand } from './audio'

export interface SpeechState { enabled: boolean; tts: boolean; status: string; mode?: 'browser' | 'local' }

export class SpeechController {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private capture: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private gain: GainNode | null = null
  private chunks: Float32Array[] = []
  private lead: Float32Array[] = []
  private samples = 0
  private lastSound = 0
  private activeUntil = 0
  private starting = false
  private recognizing = false
  private playing = false
  private busy = false
  private closed = false
  private generation = 0
  private speechSource: AudioBufferSourceNode | null = null
  private abort = new AbortController()
  private speechQueue: string[] = []
  private text = new Map<string, string>()
  private spoken = new Set<string>()
  private state: SpeechState = { enabled: false, tts: true, status: '' }
  private local = false
  private ready: Promise<void> | null = null

  private submit: (text: string) => void
  private notice: (text: string) => void
  private update: (state: SpeechState) => void
  private partial: (text: string) => void
  private wake: () => void
  constructor(submit: (text: string) => void, notice: (text: string) => void,
    update: (state: SpeechState) => void, partial: (text: string) => void, wake: () => void) {
    this.submit = submit; this.notice = notice; this.update = update; this.partial = partial
    this.wake = wake
  }

  async unlock() {
    await this.initialize()
    if (this.local || this.closed) return
    this.context ??= new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume()
  }

  private report(status: string) { this.state = { ...this.state, status }; this.update(this.state) }

  initialize() {
    this.ready ??= apiFetch('/api/speech').then(async response => {
      if (!response.ok) throw new Error('语音状态暂不可用')
      const data = await response.json()
      if (!this.closed && !this.local && data.mode === 'local' && data.local) this.localState(data.local)
    }).catch(() => { this.ready = null })
    return this.ready
  }

  private localState(state: SpeechState) {
    this.local = true
    this.state = { enabled: state.enabled, tts: state.tts, status: state.status, mode: 'local' }
    this.update(this.state)
  }

  private async control(action: string) {
    try {
      const response = await apiFetch('/api/speech/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      if (!response.ok) throw new Error('本地语音未连接')
      if (!this.closed) this.localState(await response.json())
    } catch { if (!this.closed) this.report('本地语音未连接，请检查后端服务') }
  }

  async mic() {
    await this.initialize()
    if (this.closed || this.starting) return
    if (this.local) { await this.control('resume'); return }
    if (this.stream) {
      this.interrupt()
      this.activeUntil = Date.now() + 20_000
      this.report('我在听，说完稍等一下')
      return
    }
    const generation = this.generation
    this.starting = true
    try {
      this.report('正在准备麦克风…')
      const status = await apiFetch('/api/speech', { signal: this.abort.signal }).then(r => r.json())
      if (!status.configured) throw new Error('语音还没准备好，先打字也可以。')
      await this.unlock()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      if (this.closed || generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
      await this.context!.audioWorklet.addModule(workletUrl)
      if (this.closed || generation !== this.generation) return
      this.capture = new AudioWorkletNode(this.context!, 'bluesword-capture')
      this.source = this.context!.createMediaStreamSource(stream)
      this.gain = this.context!.createGain()
      this.gain.gain.value = 0
      this.source.connect(this.capture).connect(this.gain).connect(this.context!.destination)
      this.capture.port.onmessage = (event: MessageEvent<Float32Array>) => this.frame(event.data)
      this.state = { ...this.state, enabled: true }
      this.activeUntil = Date.now() + 20_000
      this.report('我在听，说完稍等一下')
    } catch (error) {
      this.stopListening()
      if (!this.closed) this.notice(error instanceof Error && error.name === 'NotAllowedError'
        ? '打开麦克风权限后，就能和我说话啦。' : '麦克风暂时没准备好，先打字也可以。')
    } finally { this.starting = false }
  }

  stopListening() {
    if (this.local) { void this.control('pause'); return }
    this.interrupt()
    this.stream?.getTracks().forEach(track => track.stop())
    this.capture?.disconnect(); this.source?.disconnect(); this.gain?.disconnect()
    this.stream = null; this.capture = null; this.source = null; this.gain = null
    this.clearAudio()
    this.state = { ...this.state, enabled: false }
    this.partial(''); this.report('')
  }

  setTts(enabled: boolean) {
    if (this.local) { void this.control(enabled ? 'tts_on' : 'tts_off'); return }
    this.state = { ...this.state, tts: enabled }
    if (!enabled) this.interrupt()
    else void this.unlock().catch(() => {})
    this.update(this.state)
  }

  private clearAudio() { this.chunks = []; this.lead = []; this.samples = 0; this.lastSound = 0 }

  private frame(frame: Float32Array) {
    if (!this.stream || this.recognizing || this.playing || this.busy) { this.clearAudio(); return }
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length)
    const now = Date.now()
    if (rms > 0.018) {
      if (!this.lastSound) { this.chunks = [...this.lead]; this.samples = this.lead.reduce((n, part) => n + part.length, 0) }
      this.lastSound = now
    }
    if (this.lastSound) {
      this.chunks.push(frame); this.samples += frame.length
      if (now - this.lastSound > 850 || this.samples / this.context!.sampleRate > 25) void this.finish()
    } else {
      this.lead.push(frame)
      if (this.lead.length > Math.ceil(this.context!.sampleRate * 0.15 / frame.length)) this.lead.shift()
      if (now > this.activeUntil && this.state.status !== '说“你好，布鲁”叫我') this.report('说“你好，布鲁”叫我')
    }
  }

  private async finish() {
    if (this.recognizing || !this.context || !this.chunks.length) return
    const audio = pcm16(this.chunks, this.context.sampleRate)
    this.clearAudio()
    if (audio.byteLength < 6400) return
    const generation = this.generation
    const active = Date.now() < this.activeUntil
    this.recognizing = true
    if (active) this.report('正在听清这句话…')
    try {
      const response = await apiFetch('/api/speech/recognize', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio, signal: this.abort.signal })
      if (!response.ok) throw new Error('识别未完成')
      const data = await response.json() as { text: string }
      if (generation !== this.generation || this.closed) return
      const command = wakeCommand(data.text)
      if (command !== null || active) {
        const text = command ?? data.text.trim()
        this.activeUntil = Date.now() + 20_000
        if (text) { this.partial(''); this.submit(text) }
        else if (command !== null) { this.wake(); this.report('我在，接着说吧') }
        else this.report('这次没听清，再说一遍吧')
      } else this.report('说“你好，布鲁”叫我')
    } catch {
      if (generation === this.generation && !this.closed) {
        this.stopListening()
        this.notice('语音刚才没接上，点麦克风再试一下吧。')
      }
    } finally {
      if (generation === this.generation) this.recognizing = false
    }
  }

  onEvent(event: ServerEvent) {
    if (event.type === 'voice_status') { this.localState(event); return }
    if (this.local) {
      if (event.type === 'device' && !event.online) this.report('连接中 · 本地监听由后端运行')
      return
    }
    if (event.type === 'confirm_closed') { this.text.clear(); this.interrupt() }
    if (event.type === 'phase') this.busy = event.phase === 'thinking' || event.phase === 'acting'
    if (event.type === 'confirm_request') { this.busy = false; this.activeUntil = Date.now() + event.timeout_s * 1000; for (const id of this.text.keys()) this.enqueue(id) }
    if (event.type === 'assistant_start') this.text.set(event.id, '')
    if (event.type === 'assistant_delta') this.text.set(event.id, (this.text.get(event.id) ?? '') + event.text)
    if (event.type === 'assistant_end') this.enqueue(event.id)
    if (event.type === 'device' && !event.online) { this.reset(); this.busy = true }
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
    if (this.playing || !this.speechQueue.length || this.closed) return
    const text = this.speechQueue.shift()!
    const generation = this.generation
    this.playing = true
    this.clearAudio()
    try {
      const response = await apiFetch('/api/speech/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: this.abort.signal })
      if (!response.ok) throw new Error('播报暂不可用')
      const buffer = await this.context!.decodeAudioData(await response.arrayBuffer())
      if (this.closed || generation !== this.generation || !this.state.tts) return
      await new Promise<void>(resolve => {
        const source = this.context!.createBufferSource()
        this.speechSource = source; source.buffer = buffer
        source.connect(this.context!.destination); source.onended = () => { source.disconnect(); resolve() }; source.start()
      })
    } catch {
      if (!this.closed && generation === this.generation) this.report('文字已显示，播报暂时没接上')
    } finally {
      if (generation === this.generation) {
        this.playing = false; this.speechSource = null
        this.activeUntil = Date.now() + 20_000
        void this.playNext()
      }
    }
  }

  interrupt() {
    if (this.local) return // The shared backend session interrupts audio when it receives input/reset.
    this.generation++
    this.abort.abort(); this.abort = new AbortController()
    this.speechSource?.stop(); this.speechSource = null
    this.speechQueue = []; this.playing = false; this.recognizing = false; this.clearAudio()
  }

  reset() { this.interrupt(); this.text.clear(); this.busy = false; this.activeUntil = 0; this.partial('') }
  close() {
    this.closed = true
    if (!this.local) { this.interrupt(); this.stopListening() }
    void this.context?.close()
  }
}
