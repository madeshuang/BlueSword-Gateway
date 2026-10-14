import type { BoothChatMessage } from "@bluesword/contracts";
import type { BoothConfig } from "./config.js";
import { adviceInstructions, requestAdvice, type AiCallObserver, type BoothModelAdvice } from "./advice.js";

export class DeepSeekBoothAssistant {
  constructor(private readonly config: BoothConfig, private readonly transport: typeof fetch = fetch, private readonly observe?: AiCallObserver) {}
  async advise(messages: BoothChatMessage[], taskConclusion?: string): Promise<BoothModelAdvice> {
    return requestAdvice({ provider: "DeepSeek", model: this.config.deepseekModel, key: this.config.deepseekKey,
      timeoutMs: this.config.deepseekTimeoutMs, url: "https://api.deepseek.com/chat/completions",
      body: { model: this.config.deepseekModel, max_tokens: 600, thinking: { type: "disabled" }, response_format: { type: "json_object" },
        // The UI retains only display text. Preserve JSON format in assistant history;
        // past suggestions are not current selections or permission to dispatch.
        messages: [{ role: "system", content: adviceInstructions(this.config.products,taskConclusion) },
          ...messages.map(message => message.role === "assistant"
            ? { ...message, content: JSON.stringify({ reply: message.content, selection: null, taskStatusQuery: false }) } : message)] },
    },this.config.products,data=>{
      const output = data as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
      if (output.choices?.length !== 1 || output.choices[0]?.finish_reason !== "stop") throw new Error("Incomplete response");
      return JSON.parse(output.choices[0].message?.content ?? "") as unknown;
    },this.transport,this.observe);
  }
}
