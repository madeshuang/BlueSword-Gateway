/** 内部类型；机器人报文只使用 DispatchCommand，不传内部标识。 */
export interface DispatchItem { location: string; item: string; count: number }
export interface DispatchCommand { items: DispatchItem[] }
/** Strict v1.1 wire shape used by both local robot tools. */
export function isDispatchCommand(value: unknown): value is DispatchCommand {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "items") return false;
  const items = (value as DispatchCommand).items;
  return Array.isArray(items) && items.length >= 1 && items.length <= 2 && items.every(line =>
    line && typeof line === "object" && Object.keys(line).sort().join() === "count,item,location" &&
    typeof line.location === "string" && !!line.location.trim() && typeof line.item === "string" && !!line.item.trim() &&
    Number.isSafeInteger(line.count) && line.count >= 1) &&
    new Set(items.map(line=>line.item)).size === items.length && items.reduce((sum,line)=>sum+line.count,0) <= 2;
}
export interface BoothSelectionItem { productId: string; count: number }
export interface BoothTaskItem extends BoothSelectionItem { name: string; location: string }
export const productArts = ["water", "snack", "gift", "greens", "lighter_box", "playing_card_box", "pen_box", "bottle", "table_tennis_ball_box", "shuttlecock_tube", "air_pump", "aoliao", "anmuxi", "haoliyou", "shupian"] as const;
export interface BoothProduct {
  id: string; name: string; category: string; subtitle: string; description: string;
  location: string; maxCount: number; initialStock: number; art: typeof productArts[number];
  color: string; imageUrl?: string;
}
/** 可用数量已扣除当前任务预留，不代表机器人实时盘点。 */
export interface BoothStockProduct extends BoothProduct { availableCount: number }
export type BoothTaskStatus = "submitting" | "executing" | "succeeded" | "rejected" | "uncertain" | "fault" | "resolved";
export interface BoothTask {
  id: string; requestId: string; items: BoothTaskItem[]; command: DispatchCommand;
  status: BoothTaskStatus; createdAt: string; updatedAt: string; message: string;
}
export interface BoothSnapshot {
  products: BoothStockProduct[]; tasks: BoothTask[]; active: BoothTask | null; alert: string | null;
  mode: "http" | "simulator"; catalogConfirmed: boolean;
  /** Configuration readiness only; does not assert robot reachability or task availability. */
  dispatch: { ready: boolean; reason: string | null };
  waiting: { taskId: string; elapsedMs: number; remindAfterMs: number; overdue: boolean } | null;
  ai: { provider: "OpenAI" | "DeepSeek"; model: string; configured: boolean };
  /** Exposes availability only, never the staff credential. */
  operator: { configured: boolean };
}
export interface BoothSelectionClarification {
  candidate: BoothSelectionItem[];
  choices: Array<{kind: "add" | "replace" | "keep"; label: string}>;
}
export interface BoothAdvice { reply: string; selection: BoothSelectionItem[] | null; clarification?: BoothSelectionClarification }
export interface BoothChatMessage { role: "user" | "assistant"; content: string }
export function taskSummary(task: Pick<BoothTask, "items">): string {
  return task.items.map(item => `${item.name} × ${item.count}`).join("、");
}
