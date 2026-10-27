import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { BoothAdvice, BoothSnapshot, BoothStockProduct, BoothTask, DispatchCommand } from "@bluesword/contracts";
import { taskSummary } from "@bluesword/contracts";
import { ApplicationStorage } from "../storage.js";
import type { BoothConfig } from "./config.js";

export class BoothError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const blocks = (t: BoothTask) => ["submitting", "executing", "uncertain", "fault"].includes(t.status);
interface Experience { id: string; taskId: string | null }
export interface BoothTaskProgress { conclusion: string; replyOptions: string[]; orderContext?: {currentSelection: Array<{productId:string;count:number}>;taskActive:boolean} }
const unknownProgress = "暂时无法确认这次取物的进度，请查看页面取物状态，或联系现场工作人员。";
export class BoothService {
  private listeners = new Set<() => void>();
  private operatorRecovering = false;
  constructor(readonly storage: ApplicationStorage, readonly config: BoothConfig, private readonly transport: typeof fetch = fetch,
    private readonly recoverManualTask?: (taskId:string|null)=>Promise<void>) {
    // Upgrade saved task data in place; never send an old task again during upgrade.
    const db = storage.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      type LegacyTask = Omit<BoothTask, "items" | "command"> & {productId:string; command:{item:string;location:string;count:number}};
      for (const saved of storage.list<BoothTask | LegacyTask>("booth_tasks")) {
        if ("items" in saved) continue;
        const {productId, command, ...rest} = saved;
        storage.set("booth_tasks", saved.id, {...rest,
          items:[{productId, name:command.item, location:command.location, count:command.count}],
          command:{items:[command]}} satisfies BoothTask);
      }
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    const current = this.active();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const product of config.products) {
        if (storage.get<number>("booth_stock", product.id) === undefined) {
          // On first upgrade, keep the legacy active task's items unavailable too.
          const reserved = current?.items.find(item => item.productId === product.id)?.count ?? 0;
          storage.set("booth_stock", product.id, Math.max(0, product.initialStock - reserved));
        }
      }
      if (current && storage.get("booth_refundable",current.id) === undefined) {
        storage.set("booth_refundable",current.id,Object.fromEntries(current.items.map(item=>[item.productId,item.count])));
      }
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    // A pre-response restart is never interpreted as rejection or retried automatically.
    if (current?.status === "submitting") this.update(current, "uncertain", "服务重启，尚未确认机器人是否接单；请工作人员核对");
  }
  products(): BoothStockProduct[] {
    return this.config.products.map(product => ({ ...product, availableCount: this.availableCount(product.id) }));
  }
  private availableCount(productId: string): number {
    const count = this.storage.get<number>("booth_stock", productId);
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) throw new Error("库存记录不合法，请工作人员核对");
    return count;
  }
  private stockShortage(name: string, count: number, available: number): string {
    return available === 0 ? `${name}已取完，暂时无法取物。请换一种物品或联系工作人员补货。`
      : `${name}目前只剩 ${available} 份，无法提供 ${count} 份。请重新确认数量。`;
  }
  stockAdvice(advice: BoothAdvice): BoothAdvice {
    if (!advice.selection) return advice;
    for (const line of advice.selection) {
      const product = this.config.products.find(p => p.id === line.productId);
      if (!product) throw new BoothError("物品不在目录中");
      const available = this.availableCount(product.id);
      if (line.count > available) return {reply:this.stockShortage(product.name,line.count,available),selection:null};
    }
    return advice;
  }

  active(): BoothTask | null {
    const id = this.storage.get<string>("booth", "active");
    const task = id ? this.storage.get<BoothTask>("booth_tasks", id) : undefined;
    return task && blocks(task) ? task : null;
  }
  private dispatchBlockReason(): string | null {
    if (this.operatorRecovering) return "工作人员正在处理本次取物，请稍候";
    if (!this.config.dispatchUrl) return "机器人连接尚未配置，暂不能提交任务";
    if (this.config.mode === "http" && !this.config.catalogConfirmed) return "现场物品位置尚未确认，暂不能提交任务";
    return null;
  }
  snapshot(): BoothSnapshot {
    const active = this.active();
    const elapsedMs = active ? Math.max(0,Date.now()-Date.parse(active.createdAt)) : 0;
    const waiting = active && ["submitting","executing","uncertain"].includes(active.status)
      ? { taskId: active.id, elapsedMs, remindAfterMs: this.config.taskReminderMs, overdue: elapsedMs >= this.config.taskReminderMs } : null;
    const reason = this.dispatchBlockReason();
    return {
      dispatch: { ready: reason === null, reason },
      products: this.products(), active, waiting,
      tasks: this.storage.list<BoothTask>("booth_tasks").sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,12),
      alert: this.storage.get<string | null>("booth", "alert") ?? null,
      mode: this.config.mode, catalogConfirmed: this.config.catalogConfirmed,
      operator: { configured: !!this.config.operatorToken },
      ai: this.config.aiProvider === "deepseek"
        ? { provider: "DeepSeek", model: this.config.deepseekModel, configured: !!this.config.deepseekKey }
        : { provider: "OpenAI", model: this.config.openaiModel, configured: !!this.config.openaiKey },
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private publish(): void { for (const listener of this.listeners) listener(); }
  createExperience(): { id: string; token: string } {
    const token = randomBytes(32).toString("hex"), id = randomUUID();
    this.storage.set("booth_experiences", this.experienceKey(token), { id, taskId: null });
    return { id, token };
  }
  private experienceKey(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
  private experience(token: unknown): { key: string; record: Experience } {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw new BoothError("本页体验信息无效，请开始新体验或联系工作人员",403);
    const key = this.experienceKey(token), record = this.storage.get<Experience>("booth_experiences",key);
    if (!record) throw new BoothError("本页体验信息无效，请开始新体验或联系工作人员",403);
    return { key, record };
  }
  taskProgress(token: unknown): BoothTaskProgress {
    const unknown = { conclusion: unknownProgress, replyOptions: [unknownProgress] };
    try {
      const { key, record } = this.experience(token);
      if (!record.taskId || this.storage.get<string>("booth_task_experiences",record.taskId) !== key) return unknown;
      const task = this.storage.get<BoothTask>("booth_tasks",record.taskId);
      if (!task || task.id !== record.taskId) return unknown;
      const conclusions: Record<BoothTask["status"],string> = {
        submitting: "正在等待机器人回复是否接单，请稍候，不要重复确认取物。",
        executing: "机器人已接单，尚未收到完成通知，请稍候。",
        succeeded: "已收到取物完成通知，请到交付处领取。",
        rejected: "机器人未接下这次取物，请核对选择或联系现场工作人员。",
        uncertain: "机器人是否接单、取物是否结束尚未确认，请勿重复确认取物。请联系现场工作人员核对，当前尚未确认机器人是否停止。",
        fault: "这次取物出现异常，尚未确认是否结束，请勿重复确认取物。请联系现场工作人员，当前尚未确认机器人是否停止。",
        resolved: "工作人员已核对并解除新任务限制，这不代表取物完成。领取情况请向现场工作人员确认。",
      };
      if (!conclusions[task.status]) return unknown;
      const conclusion = `${taskSummary(task)}：${conclusions[task.status]}`;
      const replyOptions: Record<BoothTask["status"],string[]> = {
        submitting: [
          "还在等机器人接单，请稍候，先不要重复确认取物。",
          "目前还没确认是否接单，请稍候，先不要重复确认取物。",
        ],
        executing: [
          "已经接单了，还没收到取好通知，请再等一会儿。",
          "目前还在等取好通知，请稍候。",
        ],
        succeeded: [
          "已经取好了，请到交付处领取。",
          "现在已经取好了，到交付处领取就可以。",
        ],
        rejected: ["机器人没有接下这次取物，请核对选择，或联系现场工作人员。"],
        uncertain: ["现在还无法确认是否接单或取好，先不要重复确认取物。请联系现场工作人员核对，机器人是否停止也尚未确认。"],
        fault: ["这次取物出了异常，是否结束、机器人是否停止都还未确认。先不要重复确认取物，请联系现场工作人员协助。"],
        resolved: ["工作人员已核对并解除新任务限制，但这不代表物品已经取好。领取情况请向现场工作人员确认。"],
      };
      return { conclusion, replyOptions: replyOptions[task.status] };
    } catch (error) {
      if (!(error instanceof BoothError)) console.warn(JSON.stringify({event:"experience_progress_failed",errorCategory:"storage"}));
      return unknown;
    }
  }
  async dispatch(selection: unknown, requestId: unknown, token?: unknown): Promise<BoothTask> {
    // Legacy callers may dispatch without an experience; such tasks cannot later be claimed.
    const experience = token === undefined ? null : this.experience(token);
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new BoothError("请求标识不合法");
    if (!Array.isArray(selection) || selection.length < 1 || selection.length > 2) throw new BoothError("请选择一至两种物品，每单最多两件");
    if (selection.some(line=>!line||typeof line.productId!=="string"||!Number.isSafeInteger(line.count)||line.count<1)) throw new BoothError("物品或数量不在可选范围内");
    const chosen = selection.map(line=>({productId:line.productId as string,count:line.count as number})).sort((a,b)=>a.productId.localeCompare(b.productId));
    if (new Set(chosen.map(line=>line.productId)).size !== chosen.length) throw new BoothError("同一种物品请合并数量");
    const db = this.storage.db;
    let task: BoothTask;
    db.exec("BEGIN IMMEDIATE");
    try {
      const priorId = this.storage.get<string>("booth_requests", requestId);
      const prior = priorId ? this.storage.get<BoothTask>("booth_tasks", priorId) : undefined;
      if (prior) {
        if ((this.storage.get<string>("booth_task_experiences",prior.id) ?? null) !== (experience?.key ?? null)) throw new BoothError("这次取物属于另一段体验，请勿重复确认，联系工作人员核对",409);
        if (JSON.stringify(prior.items.map(({productId,count})=>({productId,count})).sort((a,b)=>a.productId.localeCompare(b.productId))) !== JSON.stringify(chosen)) throw new BoothError("同一请求标识的参数不同",409);
        db.exec("COMMIT"); return prior;
      }
      // New limits apply to new tasks; checking a saved request must never resend it.
      if (chosen.reduce((sum,line)=>sum+line.count,0)>2) throw new BoothError("每单最多两件");
      const items = chosen.map(line=>{
        const product=this.config.products.find(p=>p.id===line.productId);
        if (!product || line.count>product.maxCount) throw new BoothError("物品或数量不在可选范围内");
        return {...line,name:product.name,location:product.location};
      });
      const command:DispatchCommand={items:items.map(line=>({location:line.location,item:line.productId,count:line.count}))};
      if (this.active() || this.storage.get("booth", "alert")) throw new BoothError("当前任务尚未结束，请等待或联系工作人员",409);
      const reason = this.dispatchBlockReason();
      if (reason) throw new BoothError(reason,503);
      for (const item of items) {
        const available = this.availableCount(item.productId);
        if (item.count > available) throw new BoothError(this.stockShortage(item.name,item.count,available),409);
      }
      const now = new Date().toISOString();
      task = { id: randomUUID(), requestId, items, command, status: "submitting", createdAt: now, updatedAt: now, message: "正在等待机器人接单" };
      this.storage.set("booth_tasks", task.id, task);
      this.storage.set("booth_refundable",task.id,Object.fromEntries(items.map(item=>[item.productId,item.count])));
      for (const item of items) this.storage.set("booth_stock", item.productId, this.availableCount(item.productId) - item.count);
      this.storage.set("booth_requests", requestId, task.id);
      if (experience) {
        this.storage.set("booth_task_experiences",task.id,experience.key);
        this.storage.set("booth_experiences",experience.key,{ ...experience.record, taskId: task.id });
      }
      this.storage.set("booth", "active", task.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    this.publish();
    const started = performance.now();
    let upstreamStatus: number | undefined;
    try {
      const response = await this.transport(this.config.dispatchUrl!, {
        method: "POST", headers: { "Content-Type": "application/json",...(this.recoverManualTask?{"X-Booth-Manual-Task":task.id}:{}) },
        body: JSON.stringify(task.command), signal: AbortSignal.timeout(this.config.robotTimeoutMs),
        redirect: "error",
      });
      upstreamStatus = response.status;
      if (!response.ok) throw new Error("机器人接口未返回成功的HTTP响应");
      const receipt = await response.json() as { success?: unknown; data?: unknown };
      if (!receipt || typeof receipt.success !== "boolean") throw new Error("机器人接单回复格式无法识别");
      console.info(JSON.stringify({ event: "robot_receipt", taskId: task.id, requestId: task.requestId, upstreamStatus,
        accepted: receipt.success, durationMs: Math.round(performance.now() - started) }));
      const current = this.storage.get<BoothTask>("booth_tasks", task.id)!;
      // An early callback is stronger evidence than the delayed acceptance response.
      if (current.status === "submitting") {
        this.update(current, receipt.success ? "executing" : "rejected",
          receipt.success ? "机器人已接单，正在等待取物结果" :
          typeof receipt.data === "string" ? receipt.data.slice(0,1000) : "机器人未接受本次任务");
      }
    } catch {
      console.warn(JSON.stringify({ event: "robot_receipt_failed", taskId: task.id, requestId: task.requestId, upstreamStatus,
        errorCategory: "dispatch_result_unconfirmed", durationMs: Math.round(performance.now() - started) }));
      const current = this.storage.get<BoothTask>("booth_tasks", task.id)!;
      if (current.status === "submitting") this.update(current, "uncertain", "暂未确认机器人是否接单，请工作人员核对；系统不会自动重发");
    }
    return this.storage.get<BoothTask>("booth_tasks", task.id)!;
  }
  finished(): void {
    this.receiveCallback("finished", "取物任务已完成，请在交付处领取");
  }
  error(message: string): void {
    this.receiveCallback("error", message);
  }
  private receiveCallback(kind: "finished" | "error", message: string): void {
    const db = this.storage.db, callbackId = randomUUID(), started = performance.now();
    let task: BoothTask | null = null;
    const status = kind === "finished" ? "succeeded" : "fault";
    try {
      db.exec("BEGIN IMMEDIATE");
      task = this.active();
      this.storage.set("booth_callbacks", callbackId, {
        kind, at: new Date().toISOString(), payload: { activeId: task?.id ?? null, ...(kind === "error" ? { message } : {}) },
      });
      if (task) this.storage.set("booth_tasks", task.id, {
        ...task, status, message, updatedAt: new Date().toISOString(),
      });
      else if (kind === "error") this.storage.set("booth", "alert", message);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      console.error(JSON.stringify({ event: "callback_failed", callbackId, kind, taskId: task?.id ?? null,
        requestId: task?.requestId ?? null, errorCategory: "storage", durationMs: Math.round(performance.now() - started) }));
      throw error;
    }
    console.info(JSON.stringify({ event: "callback_committed", callbackId, kind, taskId: task?.id ?? null,
      requestId: task?.requestId ?? null, from: task?.status ?? null, to: task ? status : kind === "error" ? "alert" : null,
      durationMs: Math.round(performance.now() - started) }));
    if (task || kind === "error") this.publish();
  }
  resetStock(productId: unknown, confirmation: unknown): void {
    if (confirmation !== "已核对并补满库存") throw new BoothError("请先核对并补满所选物品");
    const product = this.config.products.find(p => p.id === productId);
    if (!product) throw new BoothError("物品不在目录中");
    this.resetProducts([product]);
  }
  resetAllStock(confirmation: unknown): void {
    if (confirmation !== "已核对并补满全部库存") throw new BoothError("请先核对并补满全部物品");
    this.resetProducts(this.config.products);
  }
  private resetProducts(products: BoothConfig["products"]): void {
    const db = this.storage.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.active();
      const refundable = active ? this.storage.get<Record<string,number>>("booth_refundable",active.id) ?? {} : {};
      for (const product of products) {
        const before = this.availableCount(product.id);
        this.storage.set("booth_stock",product.id,product.initialStock);
        this.audit("operator_stock_reset",{ productId:product.id, before, after:product.initialStock });
        // A reset supersedes only this product's earlier reservation accounting.
        delete refundable[product.id];
      }
      if (active) this.storage.set("booth_refundable",active.id,refundable);
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    this.publish();
  }
  async resolve(confirmed: unknown, expectedTaskId: unknown, expectedAlert: unknown): Promise<void> {
    if (confirmed !== "已核对机器人停止") throw new BoothError("请先完成现场核对");
    if (this.operatorRecovering) throw new BoothError("工作人员正在处理本次取物，请稍候",409);
    const checkedTask=()=>{
      const task=this.active(),alert=this.storage.get<string|null>("booth","alert")??null;
      if(expectedTaskId!==(task?.id??null)||expectedAlert!==alert)throw new BoothError("任务或告警已变化，请更新页面并重新现场核对",409);
      return task;
    };
    const original=checkedTask();
    this.operatorRecovering=true;
    try{
      if(this.recoverManualTask){this.publish();await this.recoverManualTask(original?.id??null);}
      const task=checkedTask();
      this.audit("operator_resolve",{activeId:task?.id??null});
      if(task)this.update(task,"resolved","工作人员已现场核对并解除新任务限制");
      this.storage.set("booth","alert",null);
    }finally{this.operatorRecovering=false;this.publish();}
  }
  private update(task: BoothTask, status: BoothTask["status"], message: string): void {
    const db = this.storage.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (status === "rejected" && task.status === "submitting") {
        const refundable = this.storage.get<Record<string,number>>("booth_refundable",task.id) ?? {};
        for (const item of task.items) this.storage.set("booth_stock",item.productId,this.availableCount(item.productId)+(refundable[item.productId] ?? 0));
        this.storage.set("booth_refundable",task.id,{});
      }
      this.storage.set("booth_tasks", task.id, { ...task, status, message, updatedAt: new Date().toISOString() });
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    console.info(JSON.stringify({ event: "task_transition", taskId: task.id, requestId: task.requestId, from: task.status, to: status }));
    this.publish();
  }
  private audit(kind: string, payload: unknown): void {
    this.storage.set("booth_callbacks", randomUUID(), { kind, at: new Date().toISOString(), payload });
  }
}
