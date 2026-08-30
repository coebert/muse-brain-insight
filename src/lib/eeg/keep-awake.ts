/**
 * Keeping a long case alive in a browser tab.
 *
 * Two things silently end a Muse recording after ten to twenty minutes:
 *
 *  1. The screen locks (phones and tablets especially). The page is frozen,
 *     the keep-alive the Muse firmware expects stops going out, and the
 *     headband idles itself off the link.
 *  2. Even without a lock, `setInterval` in a backgrounded or occluded tab is
 *     throttled to roughly once a minute, which is far too slow both for the
 *     keep-alive and for the reconnect backoff.
 *
 * A worker-driven timer keeps ticking when the page timer budget is cut, and
 * a screen wake lock stops the display sleeping in the first place. Both
 * degrade silently to no-ops where they are unsupported (older iOS Web BLE
 * browsers), so nothing here can break a case.
 */

export interface BackgroundTimer {
  stop(): void;
}

const WORKER_SOURCE = `let id=null;onmessage=(e)=>{if(e.data&&e.data.type==='start'){if(id)clearInterval(id);id=setInterval(()=>postMessage('tick'),e.data.ms);}else if(e.data&&e.data.type==='stop'){if(id)clearInterval(id);id=null;}};`;

/**
 * A repeating timer that survives background throttling where the browser
 * allows it. Falls back to a plain interval when workers are unavailable.
 */
export function createBackgroundTimer(intervalMs: number, onTick: () => void): BackgroundTimer {
  if (typeof Worker === "function" && typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      const worker = new Worker(url);
      worker.onmessage = () => onTick();
      worker.postMessage({ type: "start", ms: intervalMs });
      return {
        stop() {
          try {
            worker.postMessage({ type: "stop" });
            worker.terminate();
          } catch {
            /* already gone */
          }
          URL.revokeObjectURL(url);
        },
      };
    } catch {
      /* fall through to the plain interval */
    }
  }
  const handle = setInterval(onTick, intervalMs);
  return {
    stop() {
      clearInterval(handle);
    },
  };
}

export interface WakeLockHandle {
  release(): void;
}

interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
}

/**
 * Holds the screen awake for the length of a case, re-acquiring the lock when
 * the page comes back to the foreground (the browser drops it on every hide).
 */
export function acquireScreenWakeLock(): WakeLockHandle {
  const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & {
    wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
  });
  const request = nav?.wakeLock?.request?.bind(nav.wakeLock);
  if (!request) return { release() {} };

  let sentinel: WakeLockSentinelLike | null = null;
  let released = false;

  const take = () => {
    if (released || typeof document === "undefined" || document.visibilityState !== "visible") return;
    void request("screen")
      .then((s) => {
        if (released) void s.release().catch(() => {});
        else sentinel = s;
      })
      .catch(() => {
        /* denied — the case still runs, the screen may just sleep */
      });
  };

  const onVisible = () => {
    if (document.visibilityState === "visible" && (!sentinel || sentinel.released)) take();
  };

  take();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  return {
    release() {
      released = true;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    },
  };
}

/** Runs `cb` whenever the page returns to the foreground. Returns an unsubscribe. */
export function onForeground(cb: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const handler = () => {
    if (document.visibilityState === "visible") cb();
  };
  document.addEventListener("visibilitychange", handler);
  if (typeof window !== "undefined") window.addEventListener("focus", handler);
  return () => {
    document.removeEventListener("visibilitychange", handler);
    if (typeof window !== "undefined") window.removeEventListener("focus", handler);
  };
}
