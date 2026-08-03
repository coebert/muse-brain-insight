import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { DsaView, SqiPoint } from "@/hooks/useEegMonitor";
import { SIDE_LABEL } from "@/lib/eeg/alarms";
import { formatClock } from "@/lib/eeg/format";

const THRESHOLD_KEY = "cortextrace.sqiAlertThreshold";

export const DEFAULT_SQI_THRESHOLD = 40;
/** Signal must recover this far above the threshold before re-arming. */
const HYSTERESIS = 5;

function loadThreshold(): number {
  if (typeof window === "undefined") return DEFAULT_SQI_THRESHOLD;
  const raw = Number(window.localStorage.getItem(THRESHOLD_KEY));
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : DEFAULT_SQI_THRESHOLD;
}

type Lane = "combined" | "left" | "right";

/**
 * Visual alerts when the signal quality index drops below a configurable
 * threshold. Scoped to the active DSA view the same way marker alerts are:
 * per hemisphere in Bilateral, one merged lane in Combined/Overlay.
 */
export function useSqiAlerts(options: { history: SqiPoint[]; view: DsaView; enabled: boolean }) {
  const { history, view, enabled } = options;
  const [threshold, setThresholdState] = useState(DEFAULT_SQI_THRESHOLD);
  const [hydrated, setHydrated] = useState(false);
  const belowRef = useRef<Record<Lane, boolean>>({ combined: false, left: false, right: false });
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const viewRef = useRef(view);

  useEffect(() => {
    setThresholdState(loadThreshold());
    setHydrated(true);
  }, []);

  const setThreshold = useCallback((next: number) => {
    setThresholdState(next);
    try {
      window.localStorage.setItem(THRESHOLD_KEY, String(next));
    } catch {
      /* storage unavailable */
    }
  }, []);

  // A view change regroups the lanes; reset latches so switching view never
  // replays an alert for a drop the clinician has already seen.
  useEffect(() => {
    viewRef.current = view;
    belowRef.current = { combined: false, left: false, right: false };
  }, [view]);

  useEffect(() => {
    if (!enabled) {
      belowRef.current = { combined: false, left: false, right: false };
      return;
    }
    const point = history[history.length - 1];
    if (!point) return;
    const limit = thresholdRef.current;
    const lanes: { lane: Lane; value: number; label: string }[] =
      viewRef.current === "bilateral"
        ? [
            { lane: "left", value: point.left, label: SIDE_LABEL.left },
            { lane: "right", value: point.right, label: SIDE_LABEL.right },
          ]
        : [{ lane: "combined", value: point.sqi, label: "Combined signal" }];

    for (const l of lanes) {
      const wasBelow = belowRef.current[l.lane];
      if (!wasBelow && l.value < limit) {
        belowRef.current[l.lane] = true;
        toast.warning("Signal quality low", {
          description: `${l.label} · SQI ${l.value.toFixed(0)} % (below ${limit} %) · ${formatClock(point.t)}`,
          duration: 8000,
        });
      } else if (wasBelow && l.value >= limit + HYSTERESIS) {
        belowRef.current[l.lane] = false;
        toast.success("Signal quality recovered", {
          description: `${l.label} · SQI ${l.value.toFixed(0)} % · ${formatClock(point.t)}`,
          duration: 5000,
        });
      }
    }
  }, [history, enabled]);

  return { threshold, setThreshold, hydrated };
}
