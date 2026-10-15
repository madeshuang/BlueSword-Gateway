import type { BoothChatMessage, BoothStockProduct } from "@bluesword/contracts";
import type { BoothConfig } from "./config.js";
import type { BoothTaskProgress } from "./service.js";
import { adviceInstructions, requestAdvice, type AiCallObserver, type BoothModelAdvice } from "./advice.js";

export class OpenAIBoothAssistant {
  constructor(private readonly config: BoothConfig, private readonly transport: typeof fetch = fetch, private readonly observe?: AiCallObserver) {}
  async advise(messages: BoothChatMessage[], taskProgress?: BoothTaskProgress,
    products: BoothStockProduct[] = this.config.products.map(p=>({...p,availableCount:p.initialStock}))): Promise<BoothModelAdvice> {
    const schema = {
      type: "object", additionalProperties: false, required: ["reply","selection","taskStatusQuery"],
      properties: {
        reply: { type: "string" },
        taskStatusQuery: { type: "boolean" },
        selection: { anyOf: [
          { type: "null" },
          { type: "object", additionalProperties: false, required: ["productId","count"],
            properties: { productId: { type: "string", enum: this.config.products.map(p => p.id) }, count: { type: "integer", minimum: 1, maximum: Math.max(...this.config.products.map(p=>p.maxCount)) } } },
        ] },
      },
    };
    return requestAdvice({ provider: "OpenAI", model: this.config.openaiModel, key: this.config.openaiKey,
      timeoutMs: this.config.openaiTimeoutMs, url: this.config.openaiBaseUrl+"/responses",
      body: { model: this.config.openaiModel, store: false, max_output_tokens: 600,
        ...(this.config.openaiModel === "gpt-6-luna" ? { reasoning: { effort: "none" } }
          : this.config.openaiModel === "gpt-6.1-sol" ? { reasoning: { effort: "low" }, max_output_tokens: 2000 } : {}),
        instructions: adviceInstructions(products,taskProgress), input: messages,
        text: { format: { type: "json_schema", name: "booth_advice", strict: true, schema } } },
    },products,data=>{
      const output = data as { status?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
      if (output.status !== "completed") throw new Error("Incomplete response");
      const text = (output.output ?? []).filter(x=>x.type==="message").flatMap(x=>x.content ?? [])
        .filter(x=>x.type==="output_text").map(x=>x.text ?? "").join("");
      return JSON.parse(text) as unknown;
    },this.transport,this.observe);
  }
}
