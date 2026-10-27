import { selectionProblem } from "./conversation/selection";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  BoothSnapshot,
  BoothStockProduct,
  BoothTask,
  BoothChatMessage,
  BoothAdvice,
  BoothSelectionClarification,
  BoothSelectionItem,
} from "@bluesword/contracts";
import { taskSummary } from "@bluesword/contracts";
import {
  openExperience,
  savedExperience,
  forgetExperience,
  type BoothExperience,
} from "./experience";
interface ThinkingMessage {
  role: "thinking";
  id: string;
  content: string;
  phase: "running" | "done" | "error";
  kind: "chat" | "task";
  requestId?: string;
}
import { SpeechDraft } from "./speech/draft";
import { type VoiceControl } from "./speech/VoiceInput";
export const labels: Record<BoothTask["status"], string> = {
  submitting: "等待机器人接单",
  executing: "机器人已接单",
  succeeded: "已完成",
  rejected: "机器人未接单",
  uncertain: "等待核对",
  fault: "需要协助",
  resolved: "工作人员已处理",
};
class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
const pendingKey = "bluesword.booth.pending";
type Pending = {
  items: BoothSelectionItem[];
  requestId: string;
  experienceId?: string;
};
type Feedback = {
  message: string;
  source: "request" | "selection" | "state" | "other";
  requestId?: string;
};
type DisplayStatus = BoothTask["status"] | "idle" | "alert";
type ConversationMessage = BoothChatMessage | ThinkingMessage;
function taskThinkingContent(task: Pick<BoothTask, "items" | "status">) {
  const status = task.status === "submitting"
    ? "正在等待机器人回复是否接单。"
    : "机器人已接单，正在等待取物结果。";
  return [status, "取物计划：按清单定位货架并识别物品。", "取物计划：抓取后送到交付处。", status].join("\n");
}
export const taskNotices: Partial<Record<BoothTask["status"], string>> = {
  executing: "已接单，请稍候。",
  succeeded: "已取好，请到交付处领取。",
  rejected: "机器人未接下这次取物，请核对选择或联系现场工作人员。",
  uncertain:
    "机器人是否接单、这次取物是否结束尚未确认，请勿重复确认取物。请联系现场工作人员，当前尚未确认机器人是否停止。",
  fault:
    "这次取物需要工作人员协助，是否结束尚未确认，请勿重复确认取物。当前尚未确认机器人是否停止。",
  resolved: "这次取物已由工作人员处理，领取情况请向现场工作人员确认。",
};
export const globalAlertNotice =
  "取物服务暂需工作人员核对，请稍候。当前尚未确认机器人是否停止。";
async function api<T>(
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(
      typeof data.data === "string" ? data.data : "暂时无法连接，请稍后重试",
      response.status,
    );
  return data as T;
}
function loadPending(): Pending | null {
  try {
    const p = JSON.parse(localStorage.getItem(pendingKey) ?? "null");
    if (
      !p ||
      typeof p.requestId !== "string" ||
      (p.experienceId && p.experienceId !== savedExperience()?.id)
    )
      return null;
    const items = p.items ?? [{ productId: p.productId, count: p.count }];
    return Array.isArray(items) &&
      items.length > 0 &&
      items.every(
        (line) =>
          line &&
          typeof line.productId === "string" &&
          Number.isSafeInteger(line.count) &&
          line.count > 0,
      )
      ? {
          items,
          requestId: p.requestId,
          ...(p.experienceId ? { experienceId: p.experienceId } : {}),
        }
      : null;
  } catch {
    return null;
  }
}
function clearSavedPending(request: Pending) {
  try {
    if (
      JSON.parse(localStorage.getItem(pendingKey) ?? "null")?.requestId ===
      request.requestId
    )
      localStorage.removeItem(pendingKey);
  } catch {
    /* A saved requestId remains safe to check again. */
  }
}
function resizeComposer(input: HTMLTextAreaElement) {
  input.style.height = "32px";
  input.style.height =
    input.scrollHeight + input.offsetHeight - input.clientHeight + "px";
}
export function useBooth() {
  const [clarification,setClarification]=useState<BoothSelectionClarification|null>(null);
  const [proposalVersion, setProposalVersion] = useState(0);
  const [, setWaitingTick] = useState(0);
  const waitingAnchor = useRef<{
    waiting: NonNullable<BoothSnapshot["waiting"]>;
    at: number;
  } | null>(null);
  const [state, setState] = useState<BoothSnapshot | null>(null),
    [connected, setConnected] = useState(false);
  const [selection, setSelection] = useState<BoothSelectionItem[]>([]),
    [category, setCategory] = useState("全部");
  const [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState<Feedback | null>(null),
    [pending, setPending] = useState<Pending | null>(loadPending);
  const error = feedback?.message ?? "";
  useEffect(()=>{setClarification(null);},[selection,pending,state?.active?.id,state?.alert]);
  function setError(
    message: string,
    source: Feedback["source"] = "other",
    requestId?: string,
  ) {
    setFeedback(
      message ? { message, source, ...(requestId ? { requestId } : {}) } : null,
    );
  }
  const submission = useRef<{
    request: Pending;
    recorded: boolean;
    snapshotSeen: boolean;
  } | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]),
    [text, setText] = useState(""),
    [thinking, setThinking] = useState(false),
    [chatError, setChatError] = useState("");
  const snapshotInitialized = useRef(false),
    snapshotRevision = useRef(0),
    observedTasks = useRef(new Map<string, BoothTask["status"]>()),
    notifiedStates = useRef(new Set<string>());
  const [operatorBusy, setOperatorBusy] = useState(false);
  const [operator, setOperator] = useState(location.hash === "#operations"),
    [token, setToken] = useState(""),
    [checked, setChecked] = useState(false);
  const messageList = useRef<HTMLDivElement>(null),
    selectionVersion = useRef(0),
    experienceVersion = useRef(0),
    draftVersion = useRef(0),
    currentState = useRef(state);
  const composerInput = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false);
  const speechDraft = useRef(new SpeechDraft()),
    voice = useRef<VoiceControl>(null);
  function updateText(value: string) {
    speechDraft.current.edit(value);
    draftVersion.current++;
    setText(value);
  }
  const transcript = useRef<HTMLDivElement>(null);
  const experienceReady = useRef<Promise<BoothExperience> | null>(null),
    releaseExperience = useRef<(() => void) | null>(null);
  const experienceAbort = useRef<AbortController | null>(null);
  const taskThought = useRef<{
    id: string;
    requestId: string;
    notifiedStatuses: Set<BoothTask["status"]>;
  } | null>(null);
  function prepareExperience(fresh = false) {
    experienceAbort.current?.abort();
    const controller = new AbortController();
    experienceAbort.current = controller;
    releaseExperience.current?.();
    releaseExperience.current = null;
    const version = experienceVersion.current;
    const ready = openExperience(fresh, controller.signal).then(
      ({ credential, release }) => {
        if (version !== experienceVersion.current) {
          release();
          throw new Error("体验已切换，请重新操作。");
        }
        releaseExperience.current = release;
        setPending((current) =>
          current?.experienceId && current.experienceId !== credential.id
            ? null
            : current,
        );
        return credential;
      },
    );
    experienceReady.current = ready;
    void ready.catch((e) => {
      if (version === experienceVersion.current) setError(e.message);
    });
  }
  useEffect(() => {
    prepareExperience();
    return () => {
      experienceVersion.current++;
      experienceAbort.current?.abort();
      releaseExperience.current?.();
    };
  }, []);
  currentState.current = state;
  const selectedItems = pending?.items ?? selection,
    total = selectedItems.reduce((sum, line) => sum + line.count, 0);
  const selectionError = selectionProblem(selectedItems, state?.products ?? []);
  const invalidSelection = selectionError !== null;
  const [experienceTaskId, setExperienceTaskId] = useState<string | null>(null);
  const [dismissedCompletionId, setDismissedCompletionId] = useState<
    string | null
  >(null);
  const awaitingTaskSnapshot = !!(
    submission.current?.recorded && !submission.current.snapshotSeen
  );
  const latest =
      state?.active ??
      state?.tasks.find((task) => task.id === experienceTaskId),
    blocked = !!state?.active || !!state?.alert || awaitingTaskSnapshot;
  const completedTaskId = latest?.status === "succeeded" ? latest.id : null;
  useEffect(() => {
    if (!completedTaskId) return;
    const timer = setTimeout(
      () => setDismissedCompletionId(completedTaskId),
      10000,
    );
    return () => clearTimeout(timer);
  }, [completedTaskId]);
  const displayTask =
    latest?.status === "succeeded" && latest.id === dismissedCompletionId
      ? null
      : latest;
  function receiveSnapshot(snapshot: BoothSnapshot) {
    snapshotRevision.current++;
    currentState.current = snapshot;
    if (
      submission.current &&
      snapshot.tasks.some(
        (task) => task.requestId === submission.current!.request.requestId,
      )
    )
      submission.current.snapshotSeen = true;
    setFeedback((current) => (current?.source === "state" ? null : current));
    // The first snapshot is a baseline, not a replay of historical events.
    for (const task of [...snapshot.tasks].reverse()) {
      const key = task.id + ":" + task.status,
        previous = observedTasks.current.get(task.id);
      if (
        snapshotInitialized.current &&
        previous !== task.status &&
        !notifiedStates.current.has(key)
      ) {
        let notice = taskNotices[task.status];
        if (task.status === "succeeded" && (snapshot.active || snapshot.alert))
          notice = "取物已完成，请按当前提示继续操作。";
        if (notice) setExperienceTaskId(task.id);
      }
      if (
        task.requestId === taskThought.current?.requestId &&
        (task.status === "submitting" || task.status === "executing")
      ) {
        const id = taskThought.current.id;
        setMessages((current) =>
          current.map((message) =>
            message.role === "thinking" && message.id === id
              ? { ...message, content: taskThinkingContent(task) }
              : message,
          ),
        );
      }
      if (
        task.requestId === taskThought.current?.requestId &&
        task.status !== "submitting" &&
        task.status !== "executing" &&
        !taskThought.current.notifiedStatuses.has(task.status)
      ) {
        const id = taskThought.current.id;
        taskThought.current.notifiedStatuses.add(task.status);
        const phase =
          task.status === "succeeded" ? ("done" as const) : ("error" as const);
        setMessages((current) => [
          ...current.map((message) =>
            message.role === "thinking" && message.id === id
              ? { ...message, phase }
              : message,
          ),
          {
            role: "assistant",
            content: taskSummary(task) + "：" + taskNotices[task.status],
          },
        ]);
      }
      observedTasks.current.set(task.id, task.status);
      notifiedStates.current.add(key);
    }
    snapshotInitialized.current = true;
    if (snapshot.active) setExperienceTaskId(snapshot.active.id);
    setState(snapshot);
  }
  async function requestSnapshot(
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const revision = snapshotRevision.current;
    const snapshot = await api<BoothSnapshot>(url, body, headers);
    // A newer SSE snapshot takes precedence over an HTTP response already in flight.
    if (revision === snapshotRevision.current) receiveSnapshot(snapshot);
  }
  useEffect(() => {
    let alive = true,
      streamReceived = false;
    api<BoothSnapshot>("/api/booth")
      .then((v) => {
        if (alive && !streamReceived) receiveSnapshot(v);
      })
      .catch((e) => {
        if (alive && !streamReceived) setError(e.message, "state");
      });
    const events = new EventSource("/api/booth/events");
    events.onmessage = (e) => {
      if (alive) {
        streamReceived = true;
        receiveSnapshot(JSON.parse(e.data));
        setConnected(true);
      }
    };
    events.onerror = () => {
      if (alive) setConnected(false);
    };
    const hash = () => setOperator(location.hash === "#operations");
    window.addEventListener("hashchange", hash);
    return () => {
      alive = false;
      events.close();
      window.removeEventListener("hashchange", hash);
    };
  }, []);
  useEffect(() => {
    waitingAnchor.current = state?.waiting
      ? { waiting: state.waiting, at: performance.now() }
      : null;
  }, [state?.waiting]);
  useEffect(() => {
    const timer = setInterval(() => setWaitingTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsedWaitMs = state?.waiting
    ? state.waiting.elapsedMs +
      (waitingAnchor.current?.waiting === state.waiting
        ? Math.max(0, performance.now() - waitingAnchor.current.at)
        : 0)
    : 0;
  const overdue =
    !!state?.waiting &&
    (state.waiting.overdue || elapsedWaitMs >= state.waiting.remindAfterMs);
  useEffect(() => {
    const list = messageList.current;
    if (list) list.scrollTop = messages.length === 0 ? 0 : list.scrollHeight;
  }, [messages, thinking]);
  useLayoutEffect(() => {
    if (composerInput.current) resizeComposer(composerInput.current);
  }, [text, !!state]);
  useEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) {
        width = input.clientWidth;
        resizeComposer(input);
      }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [!!state]);
  useEffect(() => {
    const list = messageList.current;
    if (!list) return;
    let followLatest = true,
      width = list.clientWidth,
      height = list.clientHeight;
    const trackPosition = () => {
      if (list.clientWidth === width && list.clientHeight === height)
        followLatest =
          Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) < 2;
    };
    // Resize can arrive before the scroll event from the browser's End action.
    const trackKeyboard = (event: KeyboardEvent) => {
      if (event.key === "End") followLatest = true;
      else if (event.key === "Home") followLatest = false;
    };
    const observer = new ResizeObserver(() => {
      if (messages.length === 0) list.scrollTop = 0;
      else if (followLatest) list.scrollTop = list.scrollHeight;
      width = list.clientWidth;
      height = list.clientHeight;
    });
    list.addEventListener("scroll", trackPosition);
    list.addEventListener("keydown", trackKeyboard);
    observer.observe(list);
    if (transcript.current) observer.observe(transcript.current);
    return () => {
      observer.disconnect();
      list.removeEventListener("scroll", trackPosition);
      list.removeEventListener("keydown", trackKeyboard);
    };
  }, [!!state, messages.length === 0]);
  function confirmRecordedRequest(request: Pending) {
    const current = submission.current;
    if (current?.request.requestId === request.requestId) {
      if (!current.recorded) {
        current.recorded = true;
        selectionVersion.current++;
        setSelection([]);
      }
      setBusy(false);
    }
    setPending((current) =>
      current?.requestId === request.requestId ? null : current,
    );
    clearSavedPending(request);
    setFeedback((current) =>
      current?.source === "request" && current.requestId === request.requestId
        ? null
        : current,
    );
  }
  useEffect(() => {
    if (pending && state?.tasks.some((t) => t.requestId === pending.requestId))
      confirmRecordedRequest(pending);
  }, [state, pending]);
  function choose(p: BoothStockProduct) {
    if (pending || busy || p.availableCount < 1) return;
    selectionVersion.current++;
    if (selection.some((line) => line.productId === p.id)) return;
    if (total >= 2) {
      setError("每单最多两件，请先移除物品或减少数量。", "selection");
      return;
    }
    setSelection([...selection, { productId: p.id, count: 1 }]);
    setFeedback((current) =>
      current?.source === "selection" ? null : current,
    );
  }
  function changeCount(productId: string, n: number) {
    selectionVersion.current++;
    setSelection((current) =>
      current.map((line) =>
        line.productId === productId ? { ...line, count: n } : line,
      ),
    );
    setFeedback((current) =>
      current?.source === "selection" ? null : current,
    );
  }
  function removeItem(productId: string) {
    selectionVersion.current++;
    setSelection((current) =>
      current.filter((line) => line.productId !== productId),
    );
    setFeedback((current) =>
      current?.source === "selection" ? null : current,
    );
  }
  async function submit() {
    if ((!pending && (selection.length === 0 || blocked)) || busy || !connected)
      return;
    selectionVersion.current++;
    setBusy(true);
    setError("");
    if (!pending && invalidSelection) {
      setError("所选数量超过当前可取数量，请重新确认。", "selection");
      setBusy(false);
      return;
    }
    let credential: BoothExperience;
    try {
      if (!experienceReady.current)
        throw new Error("本页体验信息尚未准备好，请稍候。");
      credential = await experienceReady.current;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "无法建立本页体验信息，本次未发送。",
      );
      setBusy(false);
      return;
    }
    if (pending?.experienceId && pending.experienceId !== credential.id) {
      setError("这次取物属于另一段体验，请联系工作人员核对。");
      setBusy(false);
      return;
    }
    const request = pending ?? {
      items: selection,
      requestId: crypto.randomUUID(),
      experienceId: credential.id,
    };
    // Do not send without a saved requestId that can be recovered after reload.
    try {
      localStorage.setItem(pendingKey, JSON.stringify(request));
    } catch {
      setError("无法保存取物信息，本次未发送。请检查浏览器存储设置后重试。");
      setBusy(false);
      return;
    }
    const attempt = { request, recorded: false, snapshotSeen: false };
    submission.current = attempt;
    setPending(request);
    if (taskThought.current?.requestId !== request.requestId) {
      const id = crypto.randomUUID();
      taskThought.current = {
        id,
        requestId: request.requestId,
        notifiedStatuses: new Set(),
      };
      setMessages((current) => [
        ...current,
        {
          role: "thinking",
          id,
          requestId: request.requestId,
          kind: "task",
          phase: "running",
          content: taskThinkingContent({
            items: request.items.map((line) => {
              const p = state!.products.find((p) => p.id === line.productId);
              return {
                ...line,
                name: p?.name ?? line.productId,
                location: p?.location ?? "待核对",
              };
            }),
            status: "submitting",
          }),
        },
      ]);
    }
    let submitted = false;
    try {
      await api(
        "/api/booth/requests",
        request,
        request.experienceId
          ? { "X-Booth-Experience": credential.token }
          : undefined,
      );
      submitted = true;
      if (submission.current !== attempt) return;
      confirmRecordedRequest(request);
      await requestSnapshot("/api/booth");
    } catch (e) {
      if (submission.current !== attempt) return;
      if (
        attempt.recorded ||
        currentState.current?.tasks.some(
          (task) => task.requestId === request.requestId,
        )
      ) {
        confirmRecordedRequest(request);
        if (
          submitted &&
          !currentState.current?.tasks.some(
            (task) => task.requestId === request.requestId,
          )
        )
          setError(
            "取物请求已提交，但暂时无法更新页面状态，请等待状态恢复，请勿重复确认取物。",
            "state",
            request.requestId,
          );
        return;
      }
      const rejectedBeforeTask =
        !submitted &&
        e instanceof RequestError &&
        [400, 409, 503].includes(e.status);
      if (rejectedBeforeTask) {
        setPending(null);
        clearSavedPending(request);
      }
      if (
        !submitted &&
        e instanceof RequestError &&
        [400, 403, 409, 503].includes(e.status) &&
        !currentState.current?.tasks.some(
          (task) => task.requestId === request.requestId,
        )
      ) {
        const id = taskThought.current?.id;
        setMessages((current) => [
          ...current.map((message) =>
            message.role === "thinking" && message.id === id
              ? { ...message, phase: "error" as const }
              : message,
          ),
          { role: "assistant", content: "这次取物未能提交。" + e.message },
        ]);
      }
      setError(
        e instanceof RequestError
          ? e.message
          : "尚未收到取物确认的反馈，请核对这次取物",
        rejectedBeforeTask ? "selection" : "request",
        request.requestId,
      );
    } finally {
      if (submission.current === attempt) setBusy(false);
    }
  }
  function startExperience() {
    try {
      forgetExperience();
    } catch {
      setError("无法开始新体验，请检查浏览器存储设置或联系工作人员。");
      return;
    }
    experienceVersion.current++;
    selectionVersion.current++;
    submission.current = null;
    voice.current?.cancel("experience-changed");
    voice.current?.clearReceipts();
    taskThought.current = null;
    setMessages([]);
    updateText("");
    setThinking(false);
    setChatError("");
    setSelection([]);
    setError("");
    setExperienceTaskId(null);
    prepareExperience(true);
  }
  async function chat(input = text, fromQuickPrompt = false) {
    if (!input.trim() || thinking || (fromQuickPrompt && text.length > 0))
      return;
    const spoken=input.trim().replace(/[。！!]+$/, "");
    const choice=clarification?.choices.find(choice=>choice.label===spoken ||
      (choice.kind==="add" && /^(一起取|都要|一起要|追加)$/.test(spoken)) ||
      (choice.kind==="replace" && /^(替换|换成新的)$/.test(spoken)));
    const selectionDecision=choice&&clarification?{kind:choice.kind,candidate:clarification.candidate}:undefined;
    setClarification(null);
    voice.current?.cancel("sent-draft");
    const speechRecords = voice.current?.takeReceipts() ?? [];
    setThinking(true);
    setChatError("");
    updateText("");
    const version = selectionVersion.current,
      experience = experienceVersion.current,
      draft = draftVersion.current,
      taskId = state?.tasks[0]?.id;
    const userMessage: BoothChatMessage = {
      role: "user",
      content: input.trim(),
    };
    const next: BoothChatMessage[] = [
      ...messages.filter(
        (message): message is BoothChatMessage =>
          message.role === "user" || message.role === "assistant",
      ),
      userMessage,
    ];
    const thoughtId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      userMessage,
      {
        role: "thinking",
        id: thoughtId,
        kind: "chat",
        phase: "running",
        content: "正在回复…",
      },
    ]);
    try {
      const credential = await experienceReady.current?.catch(() => null);
      if (experience !== experienceVersion.current) return;
      const advice = await api<BoothAdvice>(
        "/api/booth/chat",
        { messages: next.slice(-11), speechRecords, currentSelection: pending || state?.active ? [] : selection, selectionDecision },
        credential ? { "X-Booth-Experience": credential.token } : undefined,
      );
      if (experience !== experienceVersion.current) return;
      setMessages((current) => [
        ...current.map((message) =>
          message.role === "thinking" && message.id === thoughtId
            ? { ...message, phase: "done" as const }
            : message,
        ),
        { role: "assistant", content: advice.reply },
      ]);
      const latestState = currentState.current,
        proposal = advice.selection;
      if(advice.clarification && !blocked && !latestState?.active && !latestState?.alert && !pending && !busy && version===selectionVersion.current && taskId===latestState?.tasks[0]?.id) {
        setClarification(advice.clarification);
      }
      if (
        proposal &&
        (proposal.length === 0 || selectionProblem(proposal, latestState?.products ?? []) === null) &&
        !blocked &&
        !latestState?.active &&
        !latestState?.alert &&
        !pending &&
        !busy &&
        taskId === latestState?.tasks[0]?.id &&
        version === selectionVersion.current
      ) {
        selectionVersion.current++;
        setSelection(proposal);
        if (proposal.length) setProposalVersion((value) => value + 1);
      }
    } catch (e) {
      if (experience === experienceVersion.current) {
        setMessages((current) =>
          current.map((message) =>
            message.role === "thinking" && message.id === thoughtId
              ? { ...message, phase: "error" }
              : message,
          ),
        );
        setChatError(e instanceof Error ? e.message : "智能助手暂不可用");
        if (draft === draftVersion.current) updateText(input);
      }
    } finally {
      if (experience === experienceVersion.current) setThinking(false);
    }
  }
  async function resolve(expectedTaskId: string | null, expectedAlert: string | null) {
    if (!state || !checked) return false;
    setOperatorBusy(true);
    setError("");
    try {
      await requestSnapshot("/api/booth/operator/resolve", {
        confirmation: "已核对机器人停止", expectedTaskId, expectedAlert,
      }, { "X-Operator-Token": token });
      setChecked(false);
      setToken("");
      return true;
    } catch (e) {
      if (e instanceof RequestError && e.status === 409) {
        setChecked(false);
        try { await requestSnapshot("/api/booth"); } catch { /* Preserve recovery error. */ }
      }
      setError(e instanceof Error ? e.message : "处理失败");
      return false;
    } finally {
      setOperatorBusy(false);
    }
  }
  async function resetStock(productId: string | null): Promise<boolean> {
    setOperatorBusy(true);
    setError("");
    try {
      await requestSnapshot(
        productId === null
          ? "/api/booth/operator/stock/reset-all"
          : "/api/booth/operator/stock/reset",
        productId === null
          ? { confirmation: "已核对并补满全部库存" }
          : { productId, confirmation: "已核对并补满库存" },
        { "X-Operator-Token": token },
      );
      setToken("");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "库存重置失败");
      return false;
    } finally {
      setOperatorBusy(false);
    }
  }
  function beginSelectionConversation() {
    if (!selectedItems.length) return;
    setMessages(current => current.length ? current : [{
      role: "assistant",
      content: "已整理你选择的物品，请核对清单后确认取物。",
    }]);
  }
  return {
    state,
    connected,
    selection,
    selectedItems,
    clarification,
    total,
    invalidSelection,
    selectionError,
    busy,
    pending,
    error,
    setError,
    messages,
    text,
    thinking,
    chatError,
    setChatError,
    operator,
    setOperator,
    operatorBusy,
    token,
    setToken,
    checked,
    setChecked,
    category,
    setCategory,
    blocked,
    awaitingTaskSnapshot,
    latest,
    displayTask,
    overdue,
    elapsedWaitMs,
    proposalVersion,
    messageList,
    transcript,
    composerInput,
    composing,
    voice,
    speechDraft,
    updateText,
    choose,
    changeCount,
    removeItem,
    submit,
    startExperience,
    beginSelectionConversation,
    chat,
    resolve,
    resetStock,
  };
}
export type BoothController = ReturnType<typeof useBooth>;
