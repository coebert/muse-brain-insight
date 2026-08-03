import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { formatClock } from "@/lib/eeg/format";

const PREFS_KEY = "cortextrace.depthWindowAlert";

export interface DepthWindowPrefs {
  /** Alerts are raised at all when true. */
  enabled: boolean;
  /** Lower bound of the notional optimal-anaesthesia window. */
  low: number;
  /** Upper bound of the notional optimal-anaesthesia window. */
  high: number;
  /** Seconds the index must stay outside the window before alerting. */
  dwellSeconds: number;
  /** Suppress alerts while the depth index is flagged unreliable. */
  requireReliable: boolean;
}

export const DEFAULT_DEPTH_WINDOW: DepthWindowPrefs = {
  enabled: true,
  low: 40,
  high: 60,
  dwellSeconds: 30,
  requireReliable: true,
};

export type DepthWindowStatus = "unknown" | "in" | "below" | "above";

/** A confirmed crossing of the notional optimal-anaesthesia window. */
export interface DepthWindowTransition {
  /** "exit" once the excursion outlasts the dwell time, "return" on recovery. */
  kind: "exit" | "return";
  /** Direction of the excursion ("below"/"above"); for a return, the direction left behind. */
  direction: "below" | "above";
  /** Session seconds at which the transition was confirmed. */
  t: number;
  /** Depth index at the transition. */
  index: number;
  /** Seconds spent outside the window at the moment of the transition. */
  heldSeconds: number;
  low: number;
  high: number;
  /** Whether the index was flagged reliable at the transition. */
  reliable: boolean;
}

function loadPrefs(): DepthWindowPrefs {
  if (typeof window === "undefined") return DEFAULT_DEPTH_WINDOW;
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_DEPTH_WINDOW;
    const parsed = JSON.parse(raw) as Partial<DepthWindowPrefs>;
    const low = Number(parsed.low);
    const high = Number(parsed.high);
    const dwell = Number(parsed.dwellSeconds);
    return {
      enabled: parsed.enabled ?? DEFAULT_DEPTH_WINDOW.enabled,
      low: Number.isFinite(low) ? Math.min(Math.max(low, 0), 99) : DEFAULT_DEPTH_WINDOW.low,
      high: Number.isFinite(high) ? Math.min(Math.max(high, 1), 100) : DEFAULT_DEPTH_WINDOW.high,
      dwellSeconds: Number.isFinite(dwell)
        ? Math.min(Math.max(dwell, 0), 300)
        : DEFAULT_DEPTH_WINDOW.dwellSeconds,
      requireReliable: parsed.requireReliable ?? DEFAULT_DEPTH_WINDOW.requireReliable,
    };
  } catch {
    return DEFAULT_DEPTH_WINDOW;
  }
}

interface Options {
  /** Latest depth index (0–100), or null when not computed. */
  index: number | null | undefined;
  /** Elapsed session seconds for the latest epoch. */
  t: number;
  /** Whether the depth index is currently trustworthy. */
  reliable: boolean;
  enabled: boolean;
  /** Called when an excursion is confirmed or resolved, for timeline marking. */
  onTransition?: (transition: DepthWindowTransition) => void;
}

/**
 * Visual alerting when the OpenIBIS depth index leaves the clinician's
 * notional optimal-anaesthesia window (default 40–60). Bounds, dwell time and
 * reliability gating are configurable and persisted on this device.
 */
export function useDepthWindowAlerts({ index, t, reliable, enabled, onTransition }: Options) {
  const [prefs, setPrefsState] = useState<DepthWindowPrefs>(DEFAULT_DEPTH_WINDOW);
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<DepthWindowStatus>("unknown");
  const [breachSeconds, setBreachSeconds] = useState(0);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const onTransitionRef = useRef(onTransition);
  onTransitionRef.current = onTransition;
  /** Session time at which the current out-of-window excursion began. */
  const sinceRef = useRef<number | null>(null);
  /** Direction already announced for the ongoing excursion. */
  const announcedRef = useRef<DepthWindowStatus | null>(null);
  /** Seconds held outside the window when the excursion was announced. */
  const announcedAtRef = useRef<number | null>(null);

  useEffect(() => {
    setPrefsState(loadPrefs());
    setHydrated(true);
  }, []);

  const setPrefs = useCallback((patch: Partial<DepthWindowPrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      if (next.high <= next.low) {
        if (patch.low != null) next.high = Math.min(100, next.low + 1);
        else next.low = Math.max(0, next.high - 1);
      }
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      sinceRef.current = null;
      announcedRef.current = null;
      announcedAtRef.current = null;
      setStatus("unknown");
      setBreachSeconds(0);
      return;
    }
    const p = prefsRef.current;
    if (index == null || (p.requireReliable && !reliable)) {
      sinceRef.current = null;
      announcedRef.current = null;
      announcedAtRef.current = null;
      setStatus("unknown");
      setBreachSeconds(0);
      return;
    }

    const next: DepthWindowStatus = index < p.low ? "below" : index > p.high ? "above" : "in";
    setStatus(next);

    if (next === "in") {
      const previous = announcedRef.current;
      if (previous === "below" || previous === "above") {
        // Total time spent outside the window for this excursion.
        const heldSeconds = Math.max(0, t - (sinceRef.current ?? announcedAtRef.current ?? t));
        onTransitionRef.current?.({
          kind: "return",
          direction: previous,
          t,
          index,
          heldSeconds,
          low: p.low,
          high: p.high,
          reliable,
        });
        if (p.enabled) {
          toast.success("Depth index back in window", {
            description: `OpenIBIS ${index.toFixed(0)} — within ${p.low}–${p.high} · ${formatClock(t)}`,
            duration: 5000,
          });
        }
      }
      sinceRef.current = null;
      announcedRef.current = null;
      announcedAtRef.current = null;
      setBreachSeconds(0);
      return;
    }

    if (
      sinceRef.current == null ||
      (announcedRef.current !== null && announcedRef.current !== next)
    ) {
      // New excursion, or the excursion flipped direction.
      sinceRef.current = t;
      announcedRef.current = null;
      announcedAtRef.current = null;
    }
    const held = Math.max(0, t - (sinceRef.current ?? t));
    setBreachSeconds(held);

    if (announcedRef.current === next) return;
    if (held < p.dwellSeconds) return;

    announcedRef.current = next;
    announcedAtRef.current = sinceRef.current ?? t;
    onTransitionRef.current?.({
      kind: "exit",
      direction: next,
      t,
      index,
      heldSeconds: held,
      low: p.low,
      high: p.high,
      reliable,
    });
    if (!p.enabled) return;
    const deep = next === "below";
    toast[deep ? "error" : "warning"](
      deep ? "Depth index below target window" : "Depth index above target window",
      {
        description: `OpenIBIS ${index.toFixed(0)} (target ${p.low}–${p.high}) for ${held.toFixed(0)} s — ${
          deep ? "possible excessive hypnotic depth" : "possible light anaesthesia"
        } · ${formatClock(t)}`,
        duration: 10000,
      },
    );
  }, [index, t, reliable, enabled]);

  return { prefs, setPrefs, hydrated, status, breachSeconds };
}
