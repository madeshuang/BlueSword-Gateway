// The credential is confined to this tab; only its hash is saved by the API.
export interface BoothExperience { id: string; token: string }
const key = "bluesword.booth.experience";
export function savedExperience(): BoothExperience | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return value && typeof value.id === "string" && typeof value.token === "string" && /^[0-9a-f]{64}$/.test(value.token) ? value : null;
  } catch { return null; }
}
export function forgetExperience(): void { sessionStorage.removeItem(key); }
export async function openExperience(fresh = false, signal?: AbortSignal): Promise<{ credential: BoothExperience; release: () => void }> {
  // Browsers copy sessionStorage when duplicating/opening a tab with an opener.
  // An exclusive lifetime lock prevents those tabs from sharing a credential.
  if (!navigator.locks) throw new Error("浏览器暂不支持独立体验关联，请使用新版浏览器或联系工作人员。");
  // Only a reload may restore a credential. A new navigation may contain a
  // copied sessionStorage even after the opener has closed and released its lock.
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const restore = !fresh && navigation?.type === "reload";
  if (!restore) forgetExperience();
  let credential = restore ? savedExperience() : null;
  for (;;) {
    signal?.throwIfAborted();
    if (!credential) {
      const response = await fetch("/api/booth/experiences", { method: "POST", signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("暂时无法建立体验关联，请刷新页面或联系工作人员。");
      credential = await response.json() as BoothExperience;
    }
    const current = credential;
    let release!: () => void;
    const lifetime = new Promise<void>(resolve => { release = resolve; });
    const acquired = await new Promise<boolean>((resolve,reject) => {
      void navigator.locks.request("bluesword.booth.experience:" + current.id, { ifAvailable: true }, async lock => {
        resolve(!!lock);
        if (lock) await lifetime;
      }).catch(reject);
    });
    if (!acquired) { credential = null; continue; }
    try { signal?.throwIfAborted();sessionStorage.setItem(key,JSON.stringify(current)); }
    catch { release(); throw new Error("无法保存体验关联，本次未发送。请检查浏览器存储设置后重试。"); }
    return { credential: current, release };
  }
}
