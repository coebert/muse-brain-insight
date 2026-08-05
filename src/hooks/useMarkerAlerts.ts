import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AlarmTone, SIDE_LABEL } from "@/lib/eeg/alarms";
import type { DsaView, HemiEvent } from "@/hooks/useEegMonitor";
import { formatClock } from "@/lib/eeg/format";

const SOUND_KEY = "cortextrace.markerAlertSound";

/** Markers within this many seconds are treated as the same bilateral episode. */
const MERGE_SECONDS = 6;

function loadSoundPref(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SOUND_KEY) !== "off";
}

function keyFor(e: HemiEvent, view: DsaView): string {
  // Bilateral view shows each hemisphere separately, so notify per side.
  // Combined/overlay views show one lane, so merge near-simultaneous sides.
  return view === "bilateral"
    ? `${e.side}:${e.kind}:${e.t.toFixed(1)}`
    : `${e.kind}:${Math.round(e.t / MERGE_SECONDS)}`;
}

/**
 * Real-time visual (and optionally audible) notifications for newly detected
 * burst-suppression and seizure markers, scoped to the active DSA view.
 */
export function useMarkerAlerts(options: { events: HemiEvent[]; view: DsaView; enabled: boolean }) {
  const { events, view, enabled } = options;
  const [soundEnabled, setSoundEnabled] = useState(loadSoundPref);
  const seenRef = useRef<Set<string>>(new Set());
  const toneRef = useRef<AlarmTone | null>(null);
  toneRef.current ??= new AlarmTone();
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;
  const viewRef = useRef(view);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SOUND_KEY, soundEnabled ? "on" : "off");
    }
  }, [soundEnabled]);

  // Switching view changes how markers are grouped: re-key what is already
  // on screen so a view change never replays old markers.
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (!enabled) {
      seenRef.current.clear();
      return;
    }
    for (const e of events) {
      const key = keyFor(e, viewRef.current);
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      const seizure = e.kind === "seizure";
      const where =
        viewRef.current === "bilateral"
          ? SIDE_LABEL[e.side]
          : events.some(
                (o) =>
                  o.kind === e.kind && o.side !== e.side && Math.abs(o.t - e.t) <= MERGE_SECONDS,
              )
            ? SIDE_LABEL.bilateral
            : SIDE_LABEL[e.side];
      const title = seizure ? "Possible seizure detected" : "Burst suppression detected";
      const description = `${where} · onset ${formatClock(e.t)} · signal ${e.quality}`;
      if (seizure) toast.error(title, { description, duration: 12000 });
      else toast.warning(title, { description, duration: 8000 });
      if (soundRef.current) toneRef.current?.notify(e.kind);
    }
  }, [events, enabled]);

  return { soundEnabled, setSoundEnabled };
}
