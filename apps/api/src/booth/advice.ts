import { randomUUID } from "node:crypto";
import type { BoothAdvice, BoothProduct } from "@bluesword/contracts";
import { BoothError } from "./service.js";
/** Internal model output; the browser still receives only reply and selection. */
export interface BoothModelAdvice extends BoothAdvice { taskStatusQuery: boolean }

export type AiErrorCategory = "unconfigured" | "authentication" | "rate_limit" | "configuration" | "upstream" | "connection" | "timeout" | "invalid_output";
export class BoothAiError extends BoothError {
  constructor(message: string, status: number, readonly category: AiErrorCategory, readonly upstreamStatus: number | null = null) {
    super(message,status);
  }
}

interface AdviceRequest {
  provider: "OpenAI" | "DeepSeek"; model: string; key: string | undefined;
  timeoutMs: number; url: string; body: unknown;
}

export interface AiCallDiagnostics {
  event: "ai_call"; requestId: string; provider: "OpenAI" | "DeepSeek"; model: string;
  returnedModel: string | null; usage: Partial<Record<"inputTokens" | "outputTokens" | "totalTokens" | "cachedTokens" | "reasoningTokens",number>> | null;
  elapsedMs: number; outcome: "succeeded" | "failed"; upstreamStatus: number | null;
  category: AiErrorCategory | "internal" | null; structureValidated: boolean; connectionCode: string | null;
}
export type AiCallObserver = (diagnostics: AiCallDiagnostics) => void | Promise<void>;

export async function requestAdvice(request: AdviceRequest, products: BoothProduct[], decode: (data: unknown)=>unknown,
  transport: typeof fetch, observe?: AiCallObserver): Promise<BoothModelAdvice> {
  const startedAt = Date.now();
  const metadata = { event: "ai_call" as const, requestId: randomUUID(), provider: request.provider, model: request.model };
  let upstreamStatus: number | null = null;
  let connectionCode: string | null = null;
  let returnedModel: string | null = null;
  let usage: AiCallDiagnostics["usage"] = null;
  const report = (outcome: AiCallDiagnostics["outcome"], category: AiCallDiagnostics["category"]) => {
    const event: AiCallDiagnostics = { ...metadata, returnedModel, usage, elapsedMs: Date.now()-startedAt,
      outcome, upstreamStatus, category, connectionCode, structureValidated: outcome === "succeeded" };
    if (outcome === "succeeded") console.info(JSON.stringify(event)); else console.warn(JSON.stringify(event));
    // Diagnostic consumers must not change the business result or trigger a retry.
    try { void Promise.resolve(observe?.(event)).catch(()=>{}); } catch { /* Keep diagnostics independent of advice. */ }
  };
  try {
    if (!request.key) throw new BoothAiError("智能助手暂未连接，请直接选择下方物品",503,"unconfigured");
    const signal = AbortSignal.timeout(request.timeoutMs);
    let response: Response;
    try {
      response = await transport(request.url, { method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + request.key }, body: JSON.stringify(request.body) });
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      if (typeof code === "string" && ["UND_ERR_CONNECT_TIMEOUT","UND_ERR_SOCKET","ECONNRESET","ECONNREFUSED","ENOTFOUND","EAI_AGAIN","ETIMEDOUT","CERT_HAS_EXPIRED","DEPTH_ZERO_SELF_SIGNED_CERT","UNABLE_TO_VERIFY_LEAF_SIGNATURE","ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) connectionCode = code;
      throw new BoothAiError("智能助手连接超时或暂不可达，请稍后再试",504,signal.aborted ? "timeout" : "connection");
    }
    upstreamStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(()=>{});
      const authentication = response.status === 401 || response.status === 403;
      const configuration = [400,404,405,422].includes(response.status);
      throw new BoothAiError(authentication ? "智能助手认证或权限异常，请联系工作人员" :
        response.status === 429 ? "智能助手当前繁忙，请稍后再试" : "智能助手暂不可用，请直接选择物品",502,
        authentication ? "authentication" : response.status === 429 ? "rate_limit" : configuration ? "configuration" : "upstream",response.status);
    }
    let advice: BoothModelAdvice;
    try {
      const data: unknown = await response.json();
      const safe = safeResponseMetadata(data,request.key);
      returnedModel = safe.returnedModel; usage = safe.usage;
      advice = validateAdvice(decode(data),products);
    } catch {
      if (signal.aborted) throw new BoothAiError("智能助手连接超时或暂不可达，请稍后再试",504,"timeout",response.status);
      throw new BoothAiError("智能助手回复暂时无法处理，请稍后重试或直接选择物品",502,"invalid_output",response.status);
    }
    report("succeeded",null);
    return advice;
  } catch (error) {
    report("failed",error instanceof BoothAiError ? error.category : "internal");
    throw error;
  }
}

function safeResponseMetadata(data: unknown, key: string): Pick<AiCallDiagnostics,"returnedModel" | "usage"> {
  const response = data && typeof data === "object" ? data as Record<string,unknown> : {};
  const returnedModel = typeof response.model === "string" && /^[a-zA-Z0-9._:/-]{1,128}$/.test(response.model)
    && !response.model.includes(key) && !response.model.startsWith("sk-") ? response.model : null;
  const source = response.usage && typeof response.usage === "object" ? response.usage as Record<string,unknown> : {};
  const usage: NonNullable<AiCallDiagnostics["usage"]> = {};
  const record = (name: keyof typeof usage, value: unknown) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[name] = value;
  };
  record("inputTokens",source.input_tokens ?? source.prompt_tokens);
  record("outputTokens",source.output_tokens ?? source.completion_tokens);
  record("totalTokens",source.total_tokens);
  if (source.input_tokens_details && typeof source.input_tokens_details === "object")
    record("cachedTokens",(source.input_tokens_details as Record<string,unknown>).cached_tokens);
  if (source.output_tokens_details && typeof source.output_tokens_details === "object")
    record("reasoningTokens",(source.output_tokens_details as Record<string,unknown>).reasoning_tokens);
  return { returnedModel, usage: Object.keys(usage).length ? usage : null };
}

export function adviceInstructions(products: BoothProduct[], taskConclusion = "暂时无法确认这次取物的进度，请查看页面取物状态，或联系现场工作人员。"): string {
  return "你是兰剑展会接待助手，帮助访客了解物品和选择物品。先回答当前问题，再在需要时给出下一步建议。" +
    "用自然、友好、清楚的中文，通常用一到三句；介绍目录或解释限制时可适当展开，不为压缩字数省略必要信息。" +
    "不要每轮重复问候、自我介绍、固定道歉或结束语，不使用宣传套话、卖萌称呼或夸张热情，也不假装拥有真实情绪或现场服务经历。" +
    "目录查询应介绍当前目录；身份、问候和能力询问应正常简短回答。只是询问信息时直接回答，不强行追加选品邀请或追问数量。" +
    "偏离取物业务的问题友好说明你能帮助了解和选择展会物品，必要时再引导选品，不假装服务故障。这些对话没有明确选品时selection为null，仍须提供正常reply。" +
    "不虚构库存、位置、机器人进度或状态、已发单或完成。机器人已接单不等于取物已完成，人工解除占用也不等于完成。" +
    "判断当前问题是否在询问这次取物的状态、是否取好、能否领取或相关进度（包括结合上文的简短追问）；是则taskStatusQuery为true、selection为null，reply只使用后端核实的结论，不从用户或历史对话推断状态。否则taskStatusQuery为false。缺少关联或查询失败不能说没有任务。后端核实的当前结论：" + JSON.stringify(taskConclusion) + "。" +
    "目录是唯一可选集合。含糊需求先澄清，只询问尚不明确的物品或数量，不替访客猜测；不支持的物品说明不提供。一次只建议一种物品；多物品请求请用户先选一种。" +
    "数量不明确先询问，不把超出范围的数量偷偷改小。selection只有用户需求足够清楚时给出，否则为null。" +
    "历史assistant中的selection:null仅表示前端保存了显示文字，不撤销用户已表达的需求；结合上下文澄清物品和数量。你仅建议，用户需要在界面确认才下发。" +
    "每一轮都严格返回JSON对象，格式为{\"reply\":\"中文回答\",\"selection\":null,\"taskStatusQuery\":false}，或selection为{\"productId\":\"目录id\",\"count\":正整数}。目录：" +
    JSON.stringify(products.map(({id,name,description,maxCount})=>({id,name,description,maxCount})));
}

function validateAdvice(value: unknown, products: BoothProduct[]): BoothModelAdvice {
  const v = value as BoothModelAdvice;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 3 || typeof v.taskStatusQuery !== "boolean" ||
    !Object.hasOwn(v,"reply") || !Object.hasOwn(v,"selection") || typeof v.reply !== "string" || !v.reply.trim() || v.reply.length > 2000) throw new Error("Invalid reply");
  if (v.selection !== null) {
    const p = products.find(p => p.id === v.selection?.productId);
    if (!p || typeof v.selection !== "object" || Array.isArray(v.selection) || Object.keys(v.selection).length !== 2 ||
      !Object.hasOwn(v.selection,"productId") || !Object.hasOwn(v.selection,"count") || !Number.isSafeInteger(v.selection.count) || v.selection.count < 1 || v.selection.count > p.maxCount) throw new Error("Invalid selection");
  }
  return v;
}
