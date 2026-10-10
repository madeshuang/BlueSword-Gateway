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
  snapshot(): BoothSnapshot {
    return {
      products: this.config.products, active: this.active(),
      tasks: this.storage.list<BoothTask>("booth_tasks").sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,12),
      alert: this.storage.get<string | null>("booth", "alert") ?? null,
      mode: this.config.mode, catalogConfirmed: this.config.catalogConfirmed,
      ai: { provider: "OpenAI", model: this.config.openaiModel, configured: !!this.config.openaiKey },
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
      if (!this.config.dispatchUrl) throw new BoothError("机器人连接尚未配置，暂不能提交任务",503);
      if (this.config.mode === "http" && !this.config.catalogConfirmed) throw new BoothError("现场物品位置尚未确认，暂不能提交任务",503);
      const now = new Date().toISOString();
      task = { id: randomUUID(), requestId, productId: product.id, command, status: "submitting", createdAt: now, updatedAt: now, message: "正在等待机器人受理" };
      this.storage.set("booth_tasks", task.id, task);
      this.storage.set("booth_requests", requestId, task.id);
      this.storage.set("booth", "active", task.id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    this.publish();
    try {
      const response = await this.transport(this.config.dispatchUrl!, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command), signal: AbortSignal.timeout(this.config.robotTimeoutMs),
        redirect: "error",
      });
      if (!response.ok) throw new Error("机器人接口未返回成功的HTTP响应");
      const receipt = await response.json() as { success?: unknown; data?: unknown };
      if (!receipt || typeof receipt.success !== "boolean") throw new Error("机器人受理响应格式不明");
      const current = this.storage.get<BoothTask>("booth_tasks", task.id)!;
      // An early callback is stronger evidence than the delayed acceptance response.
      if (current.status === "submitting") {
        this.update(current, receipt.success ? "executing" : "rejected",
          receipt.success ? "机器人已受理，正在执行取物任务" :
          typeof receipt.data === "string" ? receipt.data.slice(0,1000) : "机器人未受理本次任务");
      }
    } catch {
      const current = this.storage.get<BoothTask>("booth_tasks", task.id)!;
      if (current.status === "submitting") this.update(current, "uncertain", "暂未确认机器人是否受理，请工作人员核对；系统不会自动重发");
    }
    return this.storage.get<BoothTask>("booth_tasks", task.id)!;
  }
  finished(): void {
    const task = this.active();
    this.audit("finished", { activeId: task?.id ?? null });
    if (task) this.update(task, "succeeded", "取物任务已完成，请在交付处领取");
  }
  error(message: string): void {
    const task = this.active();
    this.audit("error", { activeId: task?.id ?? null, message });
    if (task) this.update(task, "fault", message);
    else { this.storage.set("booth", "alert", message); this.publish(); }
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
    this.publish();
  }
  private audit(kind: string, payload: unknown): void {
    this.storage.set("booth_callbacks", randomUUID(), { kind, at: new Date().toISOString(), payload });
  }
}
