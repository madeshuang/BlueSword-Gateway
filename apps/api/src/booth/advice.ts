import { randomUUID } from "node:crypto";
import type { BoothAdvice, BoothProduct, BoothStockProduct } from "@bluesword/contracts";
import { BoothError, type BoothTaskProgress } from "./service.js";
/** Internal model output; the browser still receives only reply and selection. */
export interface BoothModelAdvice extends BoothAdvice { taskStatusQuery: boolean }

/** Recognize explicit order quantities only; ambiguous wording stays with the assistant. */
export function explicitlyExceedsOrderLimit(content: string): boolean {
  if (!/^(?:请|麻烦|帮我|你好[，,\s]*)*(?:我(?:想)?(?:要|取|拿)|给我|想要|要|取|拿|来)/.test(content.trim()) ||
    /不要|不想|不是|别|不取|不用|上次|昨天|刚才|之前|已经|或者|还是|取好|取完|进度|接单|完成/.test(content)) return false;
  const chinese: Record<string,number> = {一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,百:100,千:1000,万:10000};
  const number = (value:string) => /^\d+$/.test(value) ? Number(value) : chinese[value] ?? (/[三四五六七八九十百千万]/.test(value) ? 3 : 0);
  const counts = [...content.matchAll(/(\d+|[一二两三四五六七八九十百千万]+)\s*(?:件|份|个|瓶|盒|包|副|支|杯|筒|套|只|枚|块)/g)]
    .map(match=>number(match[1]!));
  if (counts.some(count=>count>2)) return true;
  const each = /(\d+|[一二两三四五六七八九十]+)种.*各\s*(\d+|[一二两三四五六七八九十]+)/.exec(content);
  if (each && number(each[1]!)*number(each[2]!)>2) return true;
  // Sum only two explicit parallel quantities; totals, repetitions and alternatives
  // must not be mistaken for additional items.
  return counts.length===2 && /和|加|及|、/.test(content) && !/共|合计|总|[:：]|就|够|或/.test(content) && counts[0]!+counts[1]!>2;
}

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

export function adviceInstructions(products: BoothStockProduct[], taskProgress?: BoothTaskProgress): string {
  return "你是兰剑展会接待助手，帮助访客了解物品和选择物品。先回答当前问题，再在需要时给出下一步建议。" +
    "用自然、友好、清楚的中文，通常用一到三句；介绍目录或解释限制时可适当展开，不为压缩字数省略必要信息。" +
    "不要每轮重复问候、自我介绍、固定道歉或结束语，不使用宣传套话、卖萌称呼或夸张。" +
    "目录查询应介绍当前目录；身份、问候和能力询问应正常简短回答。只是询问信息时直接回答，不强行追加选品邀请或追问数量。" +
    "偏离取物业务的问题友好说明你能帮助了解和选择展会物品，必要时再引导选品，不假装服务故障。这些对话没有明确选品时selection为null，仍须提供正常reply。" +
    "不虚构库存、位置、机器人进度或状态、已发单或完成。机器人已接单不等于取物已完成，人工解除新任务限制也不等于完成。" +
    "判断当前问题是否在询问这次取物的状态、是否取好、能否领取或相关进度（包括结合上文的简短追问）；是则taskStatusQuery为true、selection为null；只有不是进度问题时才设taskStatusQuery为false。" +
    "进度回答请结合用户原话和前文，从后端提供的replyOptions中逐字选择最合适的一条；直接询问就直接回答，‘那现在呢？’等追问使用适合当前上下文的简短回应。不要每次照搬‘物品×数量：通知’的格式，不重复问候或堆客套话。" +
    "候选回答已经核对事实，不改写状态、不增加执行步骤或时间、不从用户或历史对话推断状态，也不自行补充其他文字。进度问题无法选择合适候选时，仍设taskStatusQuery为true，并使用conclusion。缺少关联或查询失败不能说没有任务。后端核实的当前结论与可用说法：" + JSON.stringify(taskProgress ?? {conclusion:"暂时无法确认这次取物的进度，请查看页面取物状态，或联系现场工作人员。",replyOptions:["暂时无法确认这次取物的进度，请查看页面取物状态，或联系现场工作人员。"]}) + "。" +
    "目录是唯一可选集合。含糊需求先澄清，只询问尚不明确的物品或数量，不替访客猜测；不支持的物品说明不提供。可建议一至两种物品，每单总数最多两件；同种两件合为一项，两种各一件列为两项。" +
    "数量不明确先询问，不把超出范围的数量偷偷改小。selection只有用户需求足够清楚时给出，否则为null。" +
    "availableCount是当前可取的剩余数量，已排除任务预留；maxCount只表示该物品每单上限，同时每单总数最多两件。请求数量超过其中任一限制时，说明具体限制，selection为null，不改成较小数量；availableCount为0时说明已取完，可建议其他有货物品。" +
    "历史assistant中的selection:null仅表示前端保存了显示文字，不撤销用户已表达的需求；结合上下文澄清物品和数量。你仅建议，用户需要在界面确认才下发。" +
    "每一轮都严格返回JSON对象，格式为{\"reply\":\"中文回答\",\"selection\":null,\"taskStatusQuery\":false}，或selection为[{\"productId\":\"目录id\",\"count\":正整数}]。目录：" +
    JSON.stringify(products.map(({id,name,description,maxCount,availableCount})=>({id,name,description,maxCount:Math.min(2,maxCount),availableCount}))) +
    "最终数量规则：无论目录maxCount写多少，每单所有物品的总数都最多2件。先核对用户原本要求的数量，再决定selection。" +
    "例如用户说‘我要3份扑克牌’，必须回答‘每单最多两件，请重新确认数量’，selection必须是null；绝不能给出count为1或2的建议，也不能回复可以取3件。" +
    "用户说‘扑克牌和圆珠笔各1份’，selection才为两项、各count:1；‘两份扑克牌’为一项count:2；数量未决定则澄清并selection:null。";
}

function validateAdvice(value: unknown, products: BoothProduct[]): BoothModelAdvice {
  const v = value as BoothModelAdvice;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 3 || typeof v.taskStatusQuery !== "boolean" ||
    !Object.hasOwn(v,"reply") || !Object.hasOwn(v,"selection") || typeof v.reply !== "string" || !v.reply.trim() || v.reply.length > 2000) throw new Error("Invalid reply");
  if (v.selection !== null) {
    if (!Array.isArray(v.selection) || v.selection.length < 1 || v.selection.length > 2) throw new Error("Invalid selection");
    for (const line of v.selection) {
      const p = products.find(p => p.id === line?.productId);
      if (!p || !line || typeof line !== "object" || Object.keys(line).length !== 2 ||
        !Object.hasOwn(line,"productId") || !Object.hasOwn(line,"count") || !Number.isSafeInteger(line.count) || line.count < 1 || line.count > p.maxCount) throw new Error("Invalid selection");
    }
    if (new Set(v.selection.map(line=>line.productId)).size !== v.selection.length || v.selection.reduce((sum,line)=>sum+line.count,0)>2) throw new Error("Invalid selection");
  }
  return v;
}
