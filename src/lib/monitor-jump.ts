/**
 * Deep-link targets inside the monitor page. The case details drawer uses
 * these to send a clinician straight to the panel that explains a metric or
 * error flag (DSA, event markers, signal quality, per-channel completeness…).
 */
export type MonitorTab = "monitor" | "signal" | "review";

export type MonitorJumpTarget =
  | "status"
  | "dsa"
  | "metrics"
  | "events"
  | "event-log"
  | "signal-quality"
  | "channels"
  | "raw"
  | "thresholds";

export const MONITOR_JUMP: Record<MonitorJumpTarget, { tab: MonitorTab; id: string; label: string }> = {
  status: { tab: "monitor", id: "mon-status", label: "case status" },
  dsa: { tab: "monitor", id: "mon-dsa", label: "DSA" },
  metrics: { tab: "monitor", id: "mon-metrics", label: "metrics" },
  events: { tab: "monitor", id: "mon-events", label: "event markers" },
  "event-log": { tab: "review", id: "mon-event-log", label: "event log" },
  "signal-quality": { tab: "signal", id: "mon-signal-quality", label: "signal quality" },
  channels: { tab: "signal", id: "mon-channels", label: "per-channel completeness" },
  raw: { tab: "signal", id: "mon-raw", label: "raw EEG" },
  thresholds: { tab: "signal", id: "mon-thresholds", label: "detection thresholds" },
};

/** Scroll a jump target into view and flash it so the eye lands on it. */
export function focusMonitorSection(id: string) {
  if (typeof document === "undefined") return;
  const run = () => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-2", "ring-signal", "ring-offset-2", "ring-offset-background");
    window.setTimeout(() => {
      el.classList.remove("ring-2", "ring-signal", "ring-offset-2", "ring-offset-background");
    }, 2200);
  };
  window.requestAnimationFrame(() => window.setTimeout(run, 90));
}
