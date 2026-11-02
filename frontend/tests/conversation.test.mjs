import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanReasoning } from '../src/reasoningText.ts'
import { pcm16, wakeCommand } from '../src/speech/audio.ts'

test('observed rule leakage never appears, including streaming prefixes', () => {
  const raw = '观众想喝可乐，货架上没有。规则说决定要拿东西时同一回复里告诉观众就去取。不过风格说要简短。我说话要口语化，简短。矿泉水比较解渴。'
  for (let i = 0; i <= raw.length; i++) {
    const visible = cleanReasoning(raw.slice(0, i), {}, true)
    assert.doesNotMatch(visible, /规则|风格|我说话|告诉观众就去取/)
  }
  assert.equal(cleanReasoning(raw, {}), '观众想喝可乐，货架上没有。矿泉水比较解渴。')
  assert.equal(cleanReasoning('pick_item(water)之后回去。', { pick_item: '取货', water: '矿泉水' }), '取货（矿泉水）之后回去。')
})

test('PCM is mono 16 kHz little endian with clipping', () => {
  const buffer = pcm16([new Float32Array(24000).fill(2), new Float32Array(24000).fill(-2)], 48000)
  assert.equal(buffer.byteLength, 32000)
  const view = new DataView(buffer)
  assert.equal(view.getInt16(0, true), 32767)
  assert.equal(view.getInt16(16000, true), -32768)
})

test('wake phrase preserves the order and ignores unrelated conversation', () => {
  assert.equal(wakeCommand('你好，布鲁，拿两瓶矿泉水。'), '拿两瓶矿泉水。')
  assert.equal(wakeCommand('你好布噜'), '')
  assert.equal(wakeCommand('你好 Blue，查询库存'), '查询库存')
  assert.equal(wakeCommand('帮我拿矿泉水'), null)
})
