/**
 * 思考链的显示层清理（大屏展示用；后端与历史记录保留模型原文）：
 * 1. 内部代号翻译成中文：pick_item → 取货，oreo → 奥利奥；
 * 2. 去掉“按规则，”“按照流程：”这类引用说明的开头，以及谈论“系统提示/提示词”的整句。
 */

const CITE_TARGET = '(?:说话风格|风格要求|系统提示|提示词|规则|流程|设定|指引|要求|提示|说明|规定|指示|风格)'
// “按规则，” “按照流程：” “根据说话风格的要求，” → 删除
const CITATION = new RegExp(`(?:按照|按|根据|依照|遵照|遵循)${CITE_TARGET}(?:的?(?:要求|规定|说明|指引))?(?:来说|来看|来)?[，,：:、]?\\s*`, 'g')
// 整句都在谈“系统提示/提示词”的元话语 → 删除整句
const META_SENTENCE = /[^。！？\n]*(?:系统提示|提示词|系统设定|指令里|说明里|规则(?:说|要求|规定)|风格(?:说|要求)|回复(?:要|必须)|我(?:的)?说话(?:要|必须))[^。！？\n]*[。！？]?/g

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function cleanReasoning(raw: string, glossary: Record<string, string>, live = false): string {
  // 先收到完整句再清理，避免半句话尚未出现关键词时先泄露到屏幕。
  const end = live ? Math.max(raw.lastIndexOf('。'), raw.lastIndexOf('！'), raw.lastIndexOf('？'), raw.lastIndexOf('\n')) + 1 : raw.length
  let text = raw.slice(0, end)
  const keys = Object.keys(glossary).sort((a, b) => b.length - a.length)
  if (keys.length) {
    // 函数调用形式：pick_item(poker) / pick_item(item_id="poker") → 取货（扑克牌）
    const call = new RegExp(`\\b(${keys.map(escape).join('|')})\\s*\\(([^()]*)\\)`, 'gi')
    text = text.replace(call, (_m, name: string, args: string) => {
      const inner = args.replace(/\b\w+\s*[=:]\s*/g, '').replace(/["'`]/g, '').trim()
      return `${glossary[name.toLowerCase()] ?? name}${inner ? `（${inner}）` : ''}`
    })
    const word = new RegExp(`\\b(${keys.map(escape).join('|')})\\b`, 'gi')
    text = text.replace(word, (m) => glossary[m.toLowerCase()] ?? m)
    text = text
      .replace(/`/g, '')
      // 中文与翻译词之间多余的空格：调用 取货（扑克牌）→ 调用取货（扑克牌）
      .replace(/([一-龥）」”])[ \t]+(?=[一-龥（「“])/g, '$1')
      // 括号里的同名列表：（安慕希/安慕希）→（安慕希）
      .replace(/[（(]([一-龥]+)(?:[/、,，]\1)+[)）]/g, '（$1）')
      // 重复：奥利奥（奥利奥）、卸货卸货、薯片薯片 → 只留一个
      .replace(/([一-龥]{2,})[（(]\1[)）]/g, '$1')
      .replace(/([一-龥]{2,})\1/g, '$1')
  }
  text = text.replace(META_SENTENCE, '')
  text = text.replace(CITATION, '')
  return text
    .replace(/([，、：:])\s*([，。、：:])/g, '$2')
    .replace(/(^|\n)\s*[，。、：:]\s*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 流式输出时末尾可能是半截英文（如 “pick_it”），先不显示，等它完整后再翻译 */
export function stableLength(cleaned: string, live: boolean): number {
  if (!live) return cleaned.length
  const tail = /[A-Za-z_][A-Za-z0-9_]*$/.exec(cleaned)
  return tail ? tail.index : cleaned.length
}
