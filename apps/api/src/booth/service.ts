import { randomUUID } from "node:crypto";
import type { BoothSnapshot, BoothTask, DispatchCommand } from "@bluesword/contracts";
import { ApplicationStorage } from "../storage.js";
import type { BoothConfig } from "./config.js";

export class BoothError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const blocks = (t: BoothTask) => ["submitting", "executing", "uncertain", "fault"].includes(t.status);
export class BoothService {
  private listeners = new Set<() => void>();
  constructor(readonly storage: ApplicationStorage, readonly config: BoothConfig, private readonly transport: typeof fetch = fetch) {
    // A pre-response restart is never interpreted as rejection or retried automatically.
    const current = this.active();
    if (current?.status === "submitting") this.update(current, "uncertain", "服务重启，受理结果尚未确认；请工作人员核对");
  }
  active(): BoothTask | null {
    const id = this.storage.get<string>("booth", "active");
    const task = id ? this.storage.get<BoothTask>("booth_tasks", id) : undefined;
    return task && blocks(task) ? task : null;
  }
  private dispatchBlockReason(): string | null {
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
      products: this.config.products, active, waiting,
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
  async dispatch(productId: unknown, count: unknown, requestId: unknown): Promise<BoothTask> {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new BoothError("请求标识不合法");
    const product = this.config.products.find(p => p.id === productId);
    if (!product || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > product.maxCount) throw new BoothError("物品或数量不在可选范围内");
    const command: DispatchCommand = { location: product.location, item: product.name, count };
    const db = this.storage.db;
    let task: BoothTask;
    db.exec("BEGIN IMMEDIATE");
    try {
      const priorId = this.storage.get<string>("booth_requests", requestId);
      const prior = priorId ? this.storage.get<BoothTask>("booth_tasks", priorId) : undefined;
      if (prior) {
        if (prior.productId !== product.id || JSON.stringify(prior.command) !== JSON.stringify(command)) throw new BoothError("同一请求标识的参数不同",409);
        db.exec("COMMIT"); return prior;
      }
      if (this.active() || this.storage.get("booth", "alert")) throw new BoothError("当前任务尚未结束，请等待或联系工作人员",409);
      const reason = this.dispatchBlockReason();
      if (reason) throw new BoothError(reason,503);
      const now = new Date().toISOString();
      task = { id: randomUUID(), requestId, productId: product.id, command, status: "submitting", createdAt: now, updatedAt: now, message: "正在等待机器人受理" };
      this.storage.set("booth_tasks", task.id, task);
      this.storage.set("booth_requests", requestId, task.id);
      this.storage.set("booth", "active", task.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    this.publish();
    const started = performance.now();
    let upstreamStatus: number | undefined;
    try {
      const response = await this.transport(this.config.dispatchUrl!, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command), signal: AbortSignal.timeout(this.config.robotTimeoutMs),
        redirect: "error",
      });
      upstreamStatus = response.status;
      if (!response.ok) throw new Error("机器人接口未返回成功的HTTP响应");
      const receipt = await response.json() as { success?: unknown; data?: unknown };
      if (!receipt || typeof receipt.success !== "boolean") throw new Error("机器人受理响应格式不明");
      console.info(JSON.stringify({ event: "robot_receipt", taskId: task.id, requestId: task.requestId, upstreamStatus,
        accepted: receipt.success, durationMs: Math.round(performance.now() - started) }));
      const current = this.storage.get<BoothTask>("booth_tasks", task.id)!;
      // An early callback is stronger evidence than the delayed acceptance response.
      if (current.status === "submitting") {
        this.update(current, receipt.success ? "executing" : "rejected",
          receipt.success ? "机器人已受理，正在执行取物任务" :
          typeof receipt.data === "string" ? receipt.data.slice(0,1000) : "机器人未受理本次任务");
      }
    } catch {
      console.warn(JSON.stringify({ event: "robot_receipt_failed", taskId: task.id, requestId: task.requestId, upstreamStatus,
        errorCategory: "dispatch_result_unconfirmed", durationMs: Math.round(performance.now() - started) }));
      const current = this.storage.get<BoothTask>("booth_tasks", task.id)!;
      if (current.status === "submitting") this.update(current, "uncertain", "暂未确认机器人是否受理，请工作人员核对；系统不会自动重发");
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
  resolve(confirmed: unknown): void {
    if (confirmed !== "已核对机器人停止") throw new BoothError("请先完成现场核对");
    const task = this.active();
    if (task && !["fault","uncertain"].includes(task.status)) throw new BoothError("执行中的任务不能在我方界面取消",409);
    this.audit("operator_resolve", { activeId: task?.id ?? null });
    if (task) this.update(task, "resolved", "工作人员已现场核对并解除本地占用");
    this.storage.set("booth", "alert", null); this.publish();
  }
  private update(task: BoothTask, status: BoothTask["status"], message: string): void {
    this.storage.set("booth_tasks", task.id, { ...task, status, message, updatedAt: new Date().toISOString() });
    console.info(JSON.stringify({ event: "task_transition", taskId: task.id, requestId: task.requestId, from: task.status, to: status }));
    this.publish();
  }
  private audit(kind: string, payload: unknown): void {
    this.storage.set("booth_callbacks", randomUUID(), { kind, at: new Date().toISOString(), payload });
  }
}
