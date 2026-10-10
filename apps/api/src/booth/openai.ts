import type { BoothAdvice, BoothChatMessage, BoothProduct } from "@bluesword/contracts";
import { BoothError } from "./service.js";
import type { BoothConfig } from "./config.js";

export class OpenAIBoothAssistant {
  constructor(private readonly config: BoothConfig, private readonly transport: typeof fetch = fetch) {}
  async advise(messages: BoothChatMessage[]): Promise<BoothAdvice> {
    if (!this.config.openaiKey) throw new BoothError("智能助手暂未连接，请直接选择下方物品",503);
    const schema = {
      type: "object", additionalProperties: false, required: ["reply","selection"],
      properties: {
        reply: { type: "string" },
        selection: { anyOf: [
          { type: "null" },
          { type: "object", additionalProperties: false, required: ["productId","count"],
            properties: { productId: { type: "string", enum: this.config.products.map(p => p.id) }, count: { type: "integer", minimum: 1, maximum: Math.max(...this.config.products.map(p=>p.maxCount)) } } },
        ] },
      },
    };
    let response: Response;
    try {
      response = await this.transport("https://api.openai.com/v1/responses", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.config.openaiTimeoutMs),
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.config.openaiKey },
        body: JSON.stringify({
          model: this.config.openaiModel, store: false, max_output_tokens: 600,
          instructions: "你是兰剑展会接待助手。用简洁自然的中文介绍下列物品，理解选品请求，不虚构库存、位置、机器人进度、已发单或完成。目录是唯一可选集合。含糊需求先澄清；不支持的物品说明不提供。一次只建议一种物品；多物品请求请用户先选一种。数量不明确先询问，不把超出范围的数量偷偷改小。selection只有用户需求足够清楚时给出，否则为null。你仅建议，用户需要在界面确认才下发。目录：" + JSON.stringify(this.config.products.map(({id,name,description,maxCount}) => ({id,name,description,maxCount}))),
          input: messages, text: { format: { type: "json_schema", name: "booth_advice", strict: true, schema } },
        }),
      });
    } catch { throw new BoothError("智能助手连接超时或暂不可达，请稍后再试",504); }
    if (!response.ok) {
      throw new BoothError(response.status === 401 || response.status === 403 ? "智能助手认证或权限异常，请联系工作人员" :
        response.status === 429 ? "智能助手当前繁忙，请稍后再试" : "智能助手暂不可用，请直接选择物品",502);
    }
    try {
      const data = await response.json() as { status?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
      if (data.status !== "completed") throw new Error("Incomplete response");
      const text = (data.output ?? []).filter(x => x.type === "message").flatMap(x => x.content ?? []).filter(x => x.type === "output_text").map(x => x.text ?? "").join("");
      return validateAdvice(JSON.parse(text), this.config.products);
    } catch { throw new BoothError("智能助手未能给出有效建议，请换一种表达或直接选择物品",502); }
  }
}
export function validateAdvice(value: unknown, products: BoothProduct[]): BoothAdvice {
  const v = value as BoothAdvice;
  if (!v || typeof v.reply !== "string" || !v.reply.trim() || v.reply.length > 2000) throw new Error("Invalid reply");
  if (v.selection !== null) {
    const p = products.find(p => p.id === v.selection?.productId);
    if (!p || !Number.isSafeInteger(v.selection.count) || v.selection.count < 1 || v.selection.count > p.maxCount) throw new Error("Invalid selection");
  }
  return v;
}
