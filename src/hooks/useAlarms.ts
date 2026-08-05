import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AlarmTone,
  highestPriority,
  type Alarm,
  type AlarmPriority,
  type AlarmSide,
} from "@/lib/eeg/alarms";

/** A condition the monitor believes is currently true. */
export interface AlarmCondition {
  id: string;
  priority: AlarmPriority;
  title: string;
  detail: string;
  side?: AlarmSide;
}

export interface ActiveAlarm extends Alarm {
  /** The condition has gone away but nobody has acknowledged it yet. */
  resolved: boolean;
}

const MUTE_SECONDS = 120;

/**
 * Latching alarm manager. Conditions are declared every analysis tick; an
 * alarm stays on screen until acknowledged even if the condition self-resolves,
 * so a two-second seizure burst is never missed.
 */
export function useAlarms(options: { enabled: boolean; onLog?: (alarm: Alarm) => void }) {
  const { enabled, onLog } = options;
  const [alarms, setAlarms] = useState<ActiveAlarm[]>([]);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [muteUntil, setMuteUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const toneRef = useRef<AlarmTone | null>(null);
  const logRef = useRef(onLog);
  logRef.current = onLog;

  toneRef.current ??= new AlarmTone();

  const sync = useCallback((conditions: AlarmCondition[], t: number) => {
    setAlarms((prev) => {
      const next: ActiveAlarm[] = [];
      for (const existing of prev) {
        const still = conditions.find((c) => c.id === existing.id);
        if (still) {
          next.push({ ...existing, ...still, resolved: false });
        } else if (existing.acknowledgedAt == null) {
          next.push({ ...existing, resolved: true });
        }
        // Acknowledged and resolved: drop it.
      }
      for (const c of conditions) {
        if (next.some((a) => a.id === c.id)) continue;
        const alarm: ActiveAlarm = { ...c, t, acknowledgedAt: null, resolved: false };
        next.push(alarm);
        logRef.current?.(alarm);
      }
      const rank: Record<AlarmPriority, number> = { high: 0, medium: 1, low: 2 };
      return next.sort((a, b) => rank[a.priority] - rank[b.priority] || b.t - a.t);
    });
  }, []);

  const acknowledge = useCallback((id: string) => {
    toneRef.current?.blip();
    setAlarms((prev) =>
      prev
        .map((a) => (a.id === id ? { ...a, acknowledgedAt: Date.now() } : a))
        .filter((a) => !(a.resolved && a.acknowledgedAt != null)),
    );
  }, []);

  const acknowledgeAll = useCallback(() => {
    toneRef.current?.blip();
    setAlarms((prev) =>
      prev
        .map((a) => (a.acknowledgedAt == null ? { ...a, acknowledgedAt: Date.now() } : a))
        .filter((a) => !(a.resolved && a.acknowledgedAt != null)),
    );
  }, []);

  /** Acknowledge every unacknowledged alarm attributed to one hemisphere. */
  const acknowledgeSide = useCallback((side: AlarmSide) => {
    toneRef.current?.blip();
    setAlarms((prev) =>
      prev
        .map((a) =>
          a.acknowledgedAt == null && (a.side === side || a.side === "bilateral")
            ? { ...a, acknowledgedAt: Date.now() }
            : a,
        )
        .filter((a) => !(a.resolved && a.acknowledgedAt != null)),
    );
  }, []);

  /** Undo an acknowledgement (10-second undo toast at the bedside). */
  const unacknowledge = useCallback((id: string) => {
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledgedAt: null } : a)));
  }, []);

  const clearAll = useCallback(() => setAlarms([]), []);

  /** Two-minute audio pause, the standard bedside behaviour. */
  const pauseAudio = useCallback(() => {
    toneRef.current?.stop();
    setMuteUntil(Date.now() + MUTE_SECONDS * 1000);
  }, []);

  const resumeAudio = useCallback(() => setMuteUntil(0), []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const unacknowledged = useMemo(() => alarms.filter((a) => a.acknowledgedAt == null), [alarms]);
  const muted = muteUntil > now;
  const muteRemaining = muted ? Math.ceil((muteUntil - now) / 1000) : 0;

  useEffect(() => {
    const tone = toneRef.current;
    if (!tone) return;
    const priority = highestPriority(unacknowledged);
    if (!enabled || !audioEnabled || muted || !priority) tone.stop();
    else tone.start(priority);
  }, [enabled, audioEnabled, muted, unacknowledged]);

  useEffect(() => () => toneRef.current?.stop(), []);

  return {
    alarms,
    unacknowledged,
    sync,
    acknowledge,
    acknowledgeAll,
    acknowledgeSide,
    unacknowledge,
    clearAll,
    audioEnabled,
    setAudioEnabled,
    muted,
    muteRemaining,
    pauseAudio,
    resumeAudio,
  };
}
