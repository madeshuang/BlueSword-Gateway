import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  CircleHelp,
  Clock3,
  LoaderCircle,
  MessageSquare,
  Package,
  PanelLeft,
  Plus,
  SlidersHorizontal,
  SquarePen,
  UserRound,
} from "lucide-react";
import { taskSummary } from "@bluesword/contracts";
import blueBrain from "./assets/blue-brain.jpg";
import blueswordLogo from "./assets/bluesword-logo.svg";
import { globalAlertNotice, labels, taskNotices, useBooth } from "./useBooth";
import { VoiceInput } from "./speech/VoiceInput";
import { Modal } from "./conversation/Modal";
import {
  CatalogDialog,
  OrderDialog,
  ProductSymbol,
} from "./conversation/SelectionDialogs";
import { OperatorDialog } from "./conversation/OperatorDialog";
import "./booth.css";

type Dialog = "catalog" | "order" | "task" | "help" | "new" | "menu" | null;
export function BoothApp() {
  const c = useBooth();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(
    null,
  );
  const [collapsed, setCollapsed] = useState(false);
  const notified = useRef(new Set<string>());
  const priorProposal = useRef(0);
  const state = c.state;
  const meaningful = c.messages.filter(
    (message) =>
      message.role !== "thinking" ||
      (message.kind === "task" && message.phase === "running"),
  );
  const welcome = meaningful.length === 0 && !c.thinking;
  const visibleDialog = !!notice || c.operator || dialog !== null;

  function open(next: Dialog) {
    setNotice(null);
    setDialog(next);
  }
  function openOperator() {
    setNotice(null);
    setDialog(null);
    c.setOperator(true);
    location.hash = "operations";
  }
  function closeOperator() {
    c.setOperator(false);
    c.setToken("");
    c.setChecked(false);
    c.setError("");
    location.hash = "";
  }
  useEffect(() => {
    if (c.proposalVersion > priorProposal.current) {
      priorProposal.current = c.proposalVersion;
      setDialog("order");
    }
  }, [c.proposalVersion]);
  useEffect(() => {
    if (
      dialog === "order" &&
      state?.active &&
      c.selectedItems.length === 0 &&
      !c.pending
    )
      setDialog(null);
  }, [dialog, state?.active, c.selectedItems.length, c.pending]);
  useEffect(() => {
    const task = c.latest;
    if (
      !task ||
      !["succeeded", "fault", "uncertain", "rejected"].includes(task.status)
    )
      return;
    const key = task.id + ":" + task.status;
    if (notified.current.has(key)) return;
    notified.current.add(key);
    setDialog(null);
    setNotice({
      title:
        task.status === "succeeded"
          ? "取物已完成"
          : task.status === "rejected"
            ? "这次取物未被接下"
            : "需要工作人员核对",
      body:
        taskSummary(task) + "。" + (taskNotices[task.status] ?? task.message),
    });
  }, [c.latest?.id, c.latest?.status]);
  useEffect(() => {
    if (c.overdue && state?.active) {
      const key = state.active.id + ":overdue";
      if (!notified.current.has(key)) {
        notified.current.add(key);
        setNotice({
          title: "取物等待时间较长",
          body: "目前尚未确认取物结束，请联系现场工作人员核对，先不要重复提交。",
        });
      }
    }
  }, [c.overdue, state?.active?.id]);
  useEffect(() => {
    const message = c.chatError || c.error;
    if (message && !c.operator && dialog !== "order")
      setNotice({
        title: c.chatError ? "助手暂时无法回复" : "请核对当前操作",
        body: message,
      });
  }, [c.chatError, c.error]);
  function closeNotice() {
    setNotice(null);
    c.setChatError("");
    c.setError("");
  }
  const nav = (
    <>
      <button
        className="new-conversation"
        onClick={() => open("new")}
        disabled={c.busy || !!c.pending || c.awaitingTaskSnapshot}
      >
        <SquarePen size={18} />
        开启新对话
      </button>
      <button onClick={() => open("catalog")}>
        <Package size={18} />
        浏览物品
      </button>
      <button onClick={() => open("task")}>
        <CheckCircle2 size={18} />
        我的取物
      </button>
    </>
  );
  if (!state)
    return (
      <main className="boot-screen">
        <img src={blueswordLogo} alt="BlueSword 兰剑智能" />
        <h1>兰剑助手</h1>
        {c.error ? (
          <>
            <p role="alert">{c.error}</p>
            <button
              className="primary-button"
              onClick={() => location.reload()}
            >
              重新连接
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" />
            <p>正在连接展台服务…</p>
          </>
        )}
      </main>
    );
  return (
    <div className={`conversation-app${collapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="conversation-sidebar" aria-label="主导航">
        <div className="sidebar-brand">
          <img src={blueswordLogo} alt="BlueSword 兰剑智能" />
          <span>兰剑智能 · 展台助手</span>
        </div>
        <nav className="sidebar-navigation">{nav}</nav>
        <div className="sidebar-caption">本次体验</div>
        <nav className="sidebar-navigation">
          <button
            className="current-conversation"
            onClick={() => {
              setDialog(null);
              setNotice(null);
            }}
          >
            <MessageSquare size={17} />
            <span>
              {c.messages
                .find((m) => m.role === "user")
                ?.content.slice(0, 14) || "与兰剑助手对话"}
            </span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <nav className="sidebar-navigation">
            <button onClick={() => open("help")}>
              <CircleHelp size={18} />
              使用帮助
            </button>
            <button onClick={openOperator}>
              <SlidersHorizontal size={18} />
              工作人员
            </button>
          </nav>
          <div className="visitor-profile">
            <span>
              <UserRound size={18} />
            </span>
            <div>
              欢迎来到兰剑展台<small>访客体验</small>
            </div>
          </div>
        </div>
      </aside>
      <main className="conversation-main">
        <header className="conversation-header">
          <button
            className="icon-button desktop-sidebar-toggle"
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => setCollapsed(!collapsed)}
          >
            <PanelLeft size={19} />
          </button>
          <button
            className="icon-button mobile-menu"
            aria-label="打开导航"
            onClick={() => open("menu")}
          >
            <PanelLeft size={19} />
          </button>
          <div className="header-assistant-brand">
            <div><small>BLUE BRAIN · 智能取物体验</small></div>
          </div>
          <span
            className={`connection-status${c.connected ? "" : " disconnected"}`}
            role="status"
          >
            <i />
            {c.connected ? "展台服务" : "连接已中断"}
          </span>
        </header>
        <div className="conversation-workspace">
        <div
          className="conversation-scroll"
          ref={c.messageList}
          role="log"
          aria-label="访客对话"
          tabIndex={0}
          aria-live="polite"
        >
          <div
            className={`conversation-column${welcome ? " welcome-column" : ""}`}
            ref={c.transcript}
          >
            {welcome ? (
              <section className="conversation-welcome">
                <div className="welcome-brand-lockup">
                  <div className="welcome-wordmark">
                    <img src={blueswordLogo} alt="BlueSword 兰剑智能" />
                    <span className="brand-eyebrow">BLUESWORD · INTELLIGENT EXPERIENCE</span>
                  </div>
                  <div className="welcome-brain"><img src={blueBrain} alt="Blue Brain 智能大脑" width={1181} height={1181} /></div>
                </div>
                <h1>你好，今天想体验什么？</h1>
                <p>我是布鲁，聊聊你的想法，让我为你挑选一份心意。</p>
              </section>
            ) : (
              <>
                {meaningful.map((message, index) =>
                  message.role === "user" ? (
                    <div className="user-message" key={index}>
                      {message.content}
                    </div>
                  ) : (
                    <article
                      className="assistant-message"
                      key={message.role === "thinking" ? message.id : index}
                    >
                      <div className="assistant-identity">
                        <img src={blueBrain} alt="" width={32} height={32} />
                        <span>兰剑助手</span>
                      </div>
                      <p>{message.content}</p>
                    </article>
                  ),
                )}
                {c.thinking && (
                  <div className="assistant-working" role="status">
                    <LoaderCircle className="spin" size={17} />
                    正在整理回复…
                  </div>
                )}
              </>
            )}
            {c.selectedItems.length > 0 && !c.pending && (
              <section
                className="selection-proposal"
                aria-label="待确认取物清单"
              >
                <div className="proposal-heading">
                  <span>为你准备的取物清单</span>
                  <small>{c.total} 件</small>
                </div>
                <div className="proposal-items">
                  {c.selectedItems.map((item) => {
                    const product = state.products.find(
                      (p) => p.id === item.productId,
                    );
                    return (
                      <span key={item.productId}>
                        {product && <ProductSymbol product={product} />}
                        <span>
                          {product?.name ?? item.productId} × {item.count}
                        </span>
                      </span>
                    );
                  })}
                </div>
                <button
                  className="primary-button"
                  onClick={() => open("order")}
                >
                  核对并确认
                  <ArrowUpRight size={16} />
                </button>
              </section>
            )}
          </div>
        </div>
        <div className="composer-area">
          {(c.displayTask ||
            c.pending ||
            state.alert ||
            c.awaitingTaskSnapshot) && (
            <div
              className={`task-strip${state.alert || c.overdue ? " attention" : ""}`}
            >
              <Clock3 size={17} />
              <span>
                {state.alert
                  ? "需要工作人员核对"
                  : c.overdue
                    ? "等待时间较长，请联系工作人员"
                    : c.pending
                      ? "请核对这次取物请求"
                      : c.displayTask
                        ? labels[c.displayTask.status]
                        : "正在同步取物状态"}
              </span>
              <button
                aria-label="查看取物进度"
                onClick={() => open(c.pending ? "order" : "task")}
              >
                查看详情
                <ArrowRight size={14} />
              </button>
            </div>
          )}
          <form
            className="conversation-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void c.chat();
            }}
          >
            <textarea
              ref={c.composerInput}
              rows={1}
              aria-label="告诉助手你的需求"
              placeholder={
                state.ai.configured
                  ? "告诉我你想要什么，或问问有什么推荐…"
                  : "助手尚未配置，你可以点击下方“选物品”"
              }
              maxLength={2000}
              value={c.text}
              disabled={!state.ai.configured}
              onCompositionStart={() => {
                c.composing.current = true;
                c.speechDraft.current.cancel();
              }}
              onCompositionEnd={() => {
                c.composing.current = false;
              }}
              onKeyDown={(e) => {
                if (
                  e.key !== "Enter" ||
                  e.shiftKey ||
                  e.nativeEvent.isComposing ||
                  c.composing.current ||
                  e.keyCode === 229
                )
                  return;
                e.preventDefault();
                void c.chat();
              }}
              onChange={(e) => {
                c.updateText(e.target.value);
                if (!e.target.value) c.voice.current?.clearReceipts();
              }}
            />
            <div className="composer-tools">
              <button
                type="button"
                className="icon-button"
                aria-label="浏览并选择物品"
                onClick={() => open("catalog")}
              >
                <Plus size={20} />
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => open("catalog")}
              >
                选物品
              </button>
              <VoiceInput
                ref={c.voice}
                draft={c.speechDraft.current}
                onText={c.updateText}
                disabled={!state.ai.configured}
              />
              <button
                type="submit"
                className="send-button"
                aria-label="发送需求"
                aria-busy={c.thinking}
                disabled={c.thinking || !state.ai.configured || !c.text.trim()}
              >
                {c.thinking ? (
                  <LoaderCircle className="spin" size={19} />
                ) : (
                  <ArrowUp size={20} />
                )}
              </button>
            </div>
          </form>
          <footer className="composer-footnote">
            由兰剑智能提供服务 · 取物前由你确认 · 每单最多两件
          </footer>
        </div>
        </div>
      </main>
      {notice && !c.operator ? (
        <Modal title={notice.title} onClose={closeNotice}>
          <p className="modal-description">{notice.body}</p>
          <footer className="modal-actions">
            {(state.active?.status === "fault" ||
              state.active?.status === "uncertain" ||
              c.overdue) && (
              <button className="secondary-button" onClick={openOperator}>
                工作人员
              </button>
            )}
            <button className="primary-button" onClick={closeNotice}>
              知道了
            </button>
          </footer>
        </Modal>
      ) : c.operator ? (
        <OperatorDialog booth={c} onClose={closeOperator} />
      ) : dialog === "catalog" ? (
        <CatalogDialog
          booth={c}
          onClose={() => setDialog(null)}
          onConfirm={() => setDialog("order")}
        />
      ) : dialog === "order" ? (
        <OrderDialog
          booth={c}
          onClose={() => {
            setDialog(null);
            c.setError("");
          }}
          onCatalog={() => setDialog("catalog")}
        />
      ) : dialog === "task" ? (
        <Modal title="我的取物" onClose={() => setDialog(null)}>
          <div className="task-detail-icon">
            {c.latest?.status === "succeeded" ? <CheckCircle2 /> : <Package />}
          </div>
          <h3 className="task-detail-title">
            {state.alert
              ? "需要工作人员核对"
              : c.latest
                ? labels[c.latest.status]
                : "还没有取物任务"}
          </h3>
          <p className="modal-description">
            {state.alert
              ? globalAlertNotice
              : c.latest
                ? taskSummary(c.latest) +
                  "。" +
                  (taskNotices[c.latest.status] ?? c.latest.message)
                : "从一份心意开始。选好喜欢的物品，核对确认后再安排取物。"}
          </p>
          {c.overdue && (
            <p className="assistant-note">
              已等待约 {Math.floor(c.elapsedWaitMs / 1000)}{" "}
              秒，请联系工作人员核对。
            </p>
          )}
          <footer className="modal-actions">
            <button className="secondary-button" onClick={openOperator}>
              工作人员
            </button>
            <button
              className="primary-button"
              onClick={() => setDialog(c.latest ? null : "catalog")}
            >
              {c.latest ? "回到对话" : "浏览物品"}
            </button>
          </footer>
        </Modal>
      ) : dialog === "new" ? (
        <Modal title="开启一段新对话？" onClose={() => setDialog(null)}>
          <p className="modal-description">
            当前对话和选择将清空。已经提交的取物请求会继续处理。
          </p>
          <footer className="modal-actions">
            <button
              className="secondary-button"
              onClick={() => setDialog(null)}
            >
              继续当前对话
            </button>
            <button
              className="primary-button"
              disabled={c.busy || !!c.pending || c.awaitingTaskSnapshot}
              onClick={() => {
                c.startExperience();
                setDialog(null);
              }}
            >
              开启新对话
            </button>
          </footer>
        </Modal>
      ) : dialog === "help" ? (
        <Modal title="很高兴为你服务" onClose={() => setDialog(null)}>
          <p className="modal-description">
            告诉我想要的物品，或点击“选物品”自行选择。每单最多两件，核对弹窗中的清单后确认取物。
          </p>
          <div className="assistant-note">
            语音识别结果会先进入草稿，检查后再发送。需要现场协助时，请联系展台工作人员。
          </div>
          <footer className="modal-actions">
            <button className="primary-button" onClick={() => setDialog(null)}>
              知道了
            </button>
          </footer>
        </Modal>
      ) : dialog === "menu" ? (
        <Modal title="兰剑助手" onClose={() => setDialog(null)}>
          <nav className="sidebar-navigation">
            {nav}
            <button onClick={() => open("help")}>
              <CircleHelp size={18} />
              使用帮助
            </button>
            <button onClick={openOperator}>
              <SlidersHorizontal size={18} />
              工作人员
            </button>
          </nav>
        </Modal>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {visibleDialog ? "弹窗已打开" : ""}
      </span>
    </div>
  );
}
