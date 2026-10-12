/** 内部类型；机器人报文只使用 DispatchCommand，不传内部标识。 */
export interface DispatchCommand { location: string; item: string; count: number }
export interface BoothProduct {
  id: string; name: string; category: string; subtitle: string; description: string;
  location: string; maxCount: number; art: "water" | "snack" | "gift" | "greens";
  color: string; imageUrl?: string;
}
export type BoothTaskStatus = "submitting" | "executing" | "succeeded" | "rejected" | "uncertain" | "fault" | "resolved";
export interface BoothTask {
  id: string; requestId: string; productId: string; command: DispatchCommand;
  status: BoothTaskStatus; createdAt: string; updatedAt: string; message: string;
}
export interface BoothSnapshot {
  products: BoothProduct[]; tasks: BoothTask[]; active: BoothTask | null; alert: string | null;
  mode: "http" | "simulator"; catalogConfirmed: boolean;
  /** Configuration readiness only; does not assert robot reachability or task availability. */
  dispatch: { ready: boolean; reason: string | null };
  waiting: { taskId: string; elapsedMs: number; remindAfterMs: number; overdue: boolean } | null;
  ai: { provider: "OpenAI" | "DeepSeek"; model: string; configured: boolean };
  /** Exposes availability only, never the staff credential. */
  operator: { configured: boolean };
}
export interface BoothAdvice { reply: string; selection: { productId: string; count: number } | null }
export interface BoothChatMessage { role: "user" | "assistant"; content: string }
