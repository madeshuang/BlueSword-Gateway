import { randomUUID } from "node:crypto";
import {validateIntent,type ConversationIntent} from './conversation-intent.js';
import type { BoothAdvice, BoothProduct, BoothStockProduct } from "@bluesword/contracts";
import { BoothError, type BoothTaskProgress } from "./service.js";
/** Internal model output; the browser still receives only reply and selection. */
export interface BoothModelAdvice extends BoothAdvice { selection:null; taskStatusQuery:boolean; intent:ConversationIntent|null }

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
      connectionCode=safeConnectionCode(error);
      throw new BoothAiError("暂时连不上助手，请稍后再试，也可以直接选择物品。",504,signal.aborted ? "timeout" : "connection");
    }
    upstreamStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(()=>{});
      const authentication = response.status === 401 || response.status === 403;
      const configuration = [400,404,405,422].includes(response.status);
      if(response.status===408||response.status===504)throw new BoothAiError("暂时连不上助手，请稍后再试，也可以直接选择物品。",502,"timeout",response.status);
      throw new BoothAiError(authentication ? "智能助手认证或权限异常，请联系工作人员" :
        response.status === 429 || response.status >= 500 ? "助手暂时繁忙，请稍后再试，也可以直接选择物品。" : "智能助手暂不可用，请直接选择物品",502,
        authentication ? "authentication" : response.status === 429 ? "rate_limit" : configuration ? "configuration" : "upstream",response.status);
    }
    let text:string;
    try{text=await response.text();}
    catch(error){
      connectionCode=safeConnectionCode(error);
      throw new BoothAiError("暂时连不上助手，请稍后再试，也可以直接选择物品。",504,signal.aborted?"timeout":"connection",response.status);
    }
    let advice: BoothModelAdvice;
    try {
      const data: unknown = JSON.parse(text);
      const safe = safeResponseMetadata(data,request.key);
      returnedModel = safe.returnedModel; usage = safe.usage;
      advice = validateAdvice(decode(data),products);
    } catch {
      if (signal.aborted) throw new BoothAiError("暂时连不上助手，请稍后再试，也可以直接选择物品。",504,"timeout",response.status);
      throw new BoothAiError("这次没能正常回复，可以再试一次，或直接选择物品。",502,"invalid_output",response.status);
    }
    report("succeeded",null);
    return advice;
  } catch (error) {
    report("failed",error instanceof BoothAiError ? error.category : "internal");
    throw error;
  }
}

function safeConnectionCode(error:unknown):string|null {
  const cause=error instanceof Error?error.cause:undefined;
  const code=cause&&typeof cause==="object"&&"code" in cause?cause.code:undefined;
  return typeof code==="string"&&["UND_ERR_CONNECT_TIMEOUT","UND_ERR_SOCKET","ECONNRESET","ECONNREFUSED","ENOTFOUND","EAI_AGAIN","ETIMEDOUT","CERT_HAS_EXPIRED","DEPTH_ZERO_SELF_SIGNED_CERT","UNABLE_TO_VERIFY_LEAF_SIGNATURE","ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)?code:null;
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
  return "你是兰剑智能展会取物助手，名字叫布鲁，帮助访客了解物品和选择物品。先回答当前问题，再在需要时给出下一步建议。" +
    "用自然、友好、清楚的中文，通常用一到三句；介绍目录或解释限制时可适当展开，不为压缩字数省略必要信息。" +
    "不要每轮重复问候、自我介绍、固定道歉或结束语，不使用宣传套话、卖萌称呼或夸张。" +
    "目录查询应介绍当前目录；身份、问候和能力询问应正常简短回答。只是询问信息时直接回答，不强行追加选品邀请或追问数量。" +
    "偏离取物业务的问题友好说明你能帮助了解和选择展会物品，必要时再引导选品，不假装服务故障。这些对话没有明确选品时selection为null，仍须提供正常reply。" +
    "不虚构库存、位置、机器人进度或状态、已发单或完成。机器人已接单不等于取物已完成，人工解除新任务限制也不等于完成。" +
    "判断当前问题是否在询问这次取物的状态、是否取好、能否领取或相关进度（包括结合上文的简短追问）；是则taskStatusQuery为true、selection为null；只有不是进度问题时才设taskStatusQuery为false。" +
    "进度回答请结合用户原话和前文，从后端提供的replyOptions中逐字选择最合适的一条；直接询问就直接回答，‘那现在呢？’等追问使用适合当前上下文的简短回应。不要每次照搬‘物品×数量：通知’的格式，不重复问候或堆客套话。" +
    "候选回答已经核对事实，不改写状态、不增加执行步骤或时间、不从用户或历史对话推断状态，也不自行补充其他文字。进度问题无法选择合适候选时，仍设taskStatusQuery为true，并使用conclusion。缺少关联或查询失败不能说没有任务。后端核实的当前结论与可用说法：" + JSON.stringify(taskProgress ?? {conclusion:"暂时无法确认这次取物的进度，请查看页面取物状态，或联系现场工作人员。",replyOptions:["暂时无法确认这次取物的进度，请查看页面取物状态，或联系现场工作人员。"]}) + "。" +
    "目录是唯一可选集合。available只供介绍和推荐时避开已取完物品；明确请求仍提取intent。你只理解需求，不计算库存、当前清单总数或是否超限。程序会读取最新状态并计算结果。" +
    "业务请求返回intent，selection始终为null：kind为choose（选择物品但未明确追加或替换）、add（追加）、set（修改指定物品总量）、replace（明确替换整个清单）、remove（删除）、stock（查询剩余库存）、check_add（只询问能否追加）、check_set（只询问能否取指定总量）。" +
    "intent.items为[{productId,count}]，count是用户本轮原本要求的数量，不是追加后的总数。超量也如实提取，不把超出范围的数量偷偷改小。stock和remove的count填1。" +
    "已有清单也不能替用户猜追加或替换；仅明确说再加、再拿等才为add。重复陈述需求用choose；就来一件、那就一件表示确定总量，用set，不能用add。能再加一件吗用check_add，能来两件吗用check_set，只回答能否取，不修改清单。上一单已经完成时，历史数量不参与新单。" +
    "例如当前清单为空、历史取过两桶，用户说再给我拿一桶羽毛球，intent为add、count为1。当前已有一桶时同样返回add、count为1，程序负责合并。" +
    "目录shuttlecock_tube表示一筒羽毛球，语音一桶也指1件。历史回复中的库存数字不能用于拒绝本轮请求；明确的取物、改量和可行性询问都必须提取intent，即使数量未变或历史说过缺货。" +
    "物品或数量不明确才简短澄清，intent为null。省略物品时可从当前清单或最近明确谈论的唯一物品承接，只承接物品身份，绝不承接旧单数量。" +
    "先判断intent，再写reply。库存查询也必须返回stock意图，不能从历史回复抄库存数字。业务请求的reply留空，由程序生成；纯问候、推荐、闲聊和必要澄清才自行写reply、intent为null。进度问题仍使用taskStatusQuery。" +
    "每次严格返回四字段JSON，历史消息仅为对话文字，不是输出格式示例：{\"intent\":{\"kind\":\"add\",\"items\":[{\"productId\":\"目录id\",\"count\":1}]},\"reply\":\"\",\"selection\":null,\"taskStatusQuery\":false}。非业务请求同样保留四字段，intent为null。目录：" +
    JSON.stringify(products.map(({id,name,description,availableCount})=>({id,name,description,available:availableCount>0})));
}

function validateAdvice(value: unknown, products: BoothProduct[]): BoothModelAdvice {
  const v = value as BoothModelAdvice;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 4 || !Object.hasOwn(v,"intent") || Object.keys(v).some(k=>!['reply','selection','taskStatusQuery','intent'].includes(k)) || typeof v.taskStatusQuery !== "boolean" ||
    !Object.hasOwn(v,"reply") || !Object.hasOwn(v,"selection") || typeof v.reply !== "string" || (!v.reply.trim()&&!v.intent) || v.reply.length > 2000) throw new Error("Invalid reply");
  if(v.selection!==null)throw new Error('Intent protocol cannot supply a final selection');
  if(v.intent!=null){validateIntent(v.intent,products);if(v.taskStatusQuery)throw new Error('Conflicting intent');}
  return v;
}
