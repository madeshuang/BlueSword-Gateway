import { useState } from "react";
import { ArrowUpRight, CheckCircle2 } from "lucide-react";
import { StockResetPanel } from "../StockResetPanel";
import { labels, type BoothController } from "../useBooth";
import { Modal } from "./Modal";

export function OperatorDialog({
  booth: c,
  onClose,
}: {
  booth: BoothController;
  onClose: () => void;
}) {
  const [action, setAction] = useState<
    | { kind: "stock"; productId: string | null }
    | { kind: "resolve"; taskId: string | null; alert: string | null }
    | null
  >(null);
  const [done, setDone] = useState("");
  const state = c.state!;
  async function perform() {
    if (!action) return;
    const ok =
      action.kind === "stock"
        ? await c.resetStock(action.productId)
        : await c.resolve(action.taskId, action.alert);
    if (ok) {
      setDone(action.kind === "stock" ? "库存已更新" : "已解除新任务限制");
      setAction(null);
    }
  }
  return (
    <Modal
      title={action ? "确认工作人员操作" : "工作人员"}
      onClose={onClose}
      locked={c.operatorBusy}
    >
      {action ? (
        <>
          <p className="modal-description">
            {action.kind !== "stock"
              ? "已核对机器人停止和现场物品情况，确认解除新任务限制？"
              : "确认将已核对的物品库存重置为补满数量？"}
          </p>
          <div className="assistant-note">
            此操作不向机器人发送停止或取消指令，也不代表取物完成。
          </div>
          {c.error && (
            <p className="form-error" role="alert">
              {c.error}
            </p>
          )}
          <footer className="modal-actions">
            <button
              className="secondary-button"
              disabled={c.operatorBusy}
              onClick={() => setAction(null)}
            >
              返回核对
            </button>
            <button
              className="primary-button"
              disabled={c.operatorBusy || !c.connected || !c.token || (action.kind === "resolve" && !c.checked)}
              onClick={() => void perform()}
            >
              {c.operatorBusy ? "正在处理…" : "确认操作"}
            </button>
          </footer>
        </>
      ) : (
        <>
          <p className="modal-description">异常核对、库存补货与运行记录。</p>
          <dl className="operator-summary">
            <div>
              <dt>运行模式</dt>
              <dd>
                {state.mode === "simulator" ? "本机人工联调" : "真实机器人"}
              </dd>
            </div>
            <div>
              <dt>网关连接</dt>
              <dd>{c.connected ? "正常" : "已中断"}</dd>
            </div>
            <div>
              <dt>任务状态</dt>
              <dd>
                {state.alert
                  ? "需要核对"
                  : c.latest
                    ? labels[c.latest.status]
                    : "暂无任务"}
              </dd>
            </div>
            <div>
              <dt>AI 服务</dt>
              <dd>
                {state.ai.provider} ·{" "}
                {state.ai.configured ? "已配置" : "未配置"}
              </dd>
            </div>
          </dl>
          {done && (
            <p className="success-message" role="status">
              <CheckCircle2 size={17} />
              {done}
            </p>
          )}
          {!state.operator.configured && (
            <p className="form-error">
              工作人员凭据尚未配置，请联系服务负责人。
            </p>
          )}
          <label className="field-label">
            工作人员凭据
            <input
              type="password"
              autoComplete="off"
              value={c.token}
              onChange={(e) => c.setToken(e.target.value)}
              disabled={!state.operator.configured}
              placeholder="请输入操作口令"
            />
          </label>
          <details
            className="operator-section"
            open={
              !!state.active || !!state.alert
            }
          >
            <summary>异常任务处理</summary>
            <p>
              {state.alert ?? c.latest?.message ?? "目前没有需要处理的任务。"}
            </p>
            <p>仅在现场核对后解除限制，不会自动恢复库存。</p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={c.checked}
                onChange={(e) => c.setChecked(e.target.checked)}
              />
              已现场核对机器人停止及物品情况
            </label>
            <button
              className="secondary-button"
              disabled={
                c.operatorBusy ||
                !c.connected ||
                !c.checked ||
                !c.token ||
                (!state.alert && !state.active)
              }
              onClick={() => {
                c.setError("");
                setAction({ kind: "resolve", taskId: state.active?.id ?? null, alert: state.alert });
              }}
            >
              解除新任务限制
            </button>
          </details>
          <details className="operator-section">
            <summary>库存补货</summary>
            <StockResetPanel
              products={state.products}
              disabled={
                c.operatorBusy ||
                !c.connected ||
                !state.operator.configured ||
                !c.token
              }
              onReset={async (productId) => {
                c.setError("");
                setAction({ kind: "stock", productId });
                return false;
              }}
            />
          </details>
          <div className="record-links">
            <a href="/developer/robot" target="_blank" rel="noreferrer">
              机器人通信记录
              <ArrowUpRight size={15} />
            </a>
            <a href="/developer/speech" target="_blank" rel="noreferrer">
              语音识别记录
              <ArrowUpRight size={15} />
            </a>
          </div>
          {c.error && (
            <p className="form-error" role="alert">
              {c.error}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
