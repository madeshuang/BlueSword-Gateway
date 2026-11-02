export function pcm16(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const samples = new Float32Array(size)
  let offset = 0
  for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length }
  const length = Math.floor(size * 16000 / sampleRate)
  const output = new ArrayBuffer(length * 2)
  const view = new DataView(output)
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * sampleRate / 16000)
    const end = Math.min(size, Math.max(start + 1, Math.floor((i + 1) * sampleRate / 16000)))
    let sum = 0
    for (let n = start; n < end; n++) sum += samples[n]
    const value = Math.max(-1, Math.min(1, sum / (end - start)))
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return output
}

export function wakeCommand(text: string): string | null {
  const match = /^[\s，,。！!？?]*(?:(?:你好[，,、\s]*)?(?:布鲁|布噜|布路|布卢|blue(?![a-z]))|hello[，,\s]+blue\b)[，,。！!？?.、：:\s]*/i.exec(text)
  return match ? text.slice(match.index + match[0].length).trim() : null
}
