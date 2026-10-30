import type { BoothChatMessage, BoothStockProduct } from "@bluesword/contracts";
import type { BoothConfig } from "./config.js";
import type { BoothTaskProgress } from "./service.js";
import { adviceInstructions, requestAdvice, type AiCallObserver, type BoothModelAdvice } from "./advice.js";

export class DeepSeekBoothAssistant {
  constructor(private readonly config: BoothConfig, private readonly transport: typeof fetch = fetch, private readonly observe?: AiCallObserver) {}
  async advise(messages: BoothChatMessage[], taskProgress?: BoothTaskProgress,
    products: BoothStockProduct[] = this.config.products.map(p=>({...p,availableCount:p.initialStock}))): Promise<BoothModelAdvice> {
    return requestAdvice({ provider: "DeepSeek", model: this.config.deepseekModel, key: this.config.deepseekKey,
      timeoutMs: this.config.deepseekTimeoutMs, url: "https://api.deepseek.com/chat/completions",
      body: { model: this.config.deepseekModel, max_tokens: 600, thinking: { type: "disabled" }, response_format: { type: "json_object" },
        // JSON mode must not imitate historical UI text (or fabricated intent:null
        // decisions). Keep the transcript as context data with its original roles.
        messages: [{ role: "system", content: adviceInstructions(products,taskProgress) },
          {role:"user",content:JSON.stringify({history:messages.slice(0,-1),message:messages.at(-1)?.content??''})}] },
    },products,data=>{
      const output = data as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
      if (output.choices?.length !== 1 || output.choices[0]?.finish_reason !== "stop") throw new Error("Incomplete response");
      return JSON.parse(output.choices[0].message?.content ?? "") as unknown;
    },this.transport,this.observe);
  }
}
