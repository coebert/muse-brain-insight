import type { MonitorStatus } from "@/hooks/useEegMonitor";

/** Link states shown at the bedside, in plain clinical language. */
export type ConnectionState =
  | "idle"
  | "ended"
  | "connecting"
  | "streaming"
  | "sleeping"
  | "reconnecting"
  | "lost";

export interface ConnectionStatusView {
  state: ConnectionState;
  label: string;
  detail: string;
}

/** Samples may pause this long before the link is called "sleeping". */
export const SLEEPING_AFTER_SECONDS = 6;

/**
 * Turns the raw monitor status into one unambiguous bedside label: a link that
 * is up but silent reads as "sleeping" rather than pretending to stream.
 */
export function deriveConnectionStatus(input: {
  status: MonitorStatus;
  sourceName: string;
  caseEnded: boolean;
  dataGapSeconds: number;
  reconnectAttempt: { attempt: number; attempts: number } | null;
  /** The headband's own retry loop is still working on a dropped link. */
  autoRetrying?: boolean;
}): ConnectionStatusView {
  const { status, sourceName, caseEnded, dataGapSeconds, reconnectAttempt } = input;
  const device = sourceName || "Headband";
  const retrying = input.autoRetrying ?? false;

  if (status === "reconnecting") {
    const a = reconnectAttempt;
    return {
      state: "reconnecting",
      label: a ? `reconnecting ${a.attempt}/${a.attempts}` : "reconnecting",
      detail: `${device} dropped out — the case keeps running while the link is rebuilt. Nothing recorded so far is lost.`,
    };
  }
  if (status === "connecting") {
    return { state: "connecting", label: "connecting", detail: `Opening the link to ${device}.` };
  }
  if (status === "error") {
    // The retry loop runs for as long as the case does: say so, rather than
    // reading as a dead end the clinician has to act on.
    if (retrying && !caseEnded) {
      return {
        state: "reconnecting",
        label: "reconnecting…",
        detail: `${device} has not come back yet. The case keeps running and reconnection retries automatically; everything recorded is kept.`,
      };
    }
    return {
      state: "lost",
      label: "link lost",
      detail: `${device} is not reachable. Recorded data is kept; reconnect to resume.`,
    };
  }
  if (status === "streaming") {
    if (dataGapSeconds >= SLEEPING_AFTER_SECONDS) {
      return {
        state: "sleeping",
        label: `sleeping ${Math.round(dataGapSeconds)}s`,
        detail: `${device} is connected but has sent no samples for ${Math.round(dataGapSeconds)}s. The monitor is nudging it awake; this segment is marked as a gap.`,
      };
    }
    return { state: "streaming", label: `${device} · live`, detail: "Samples arriving normally." };
  }
  if (caseEnded) {
    return { state: "ended", label: "case ended", detail: "No live link; review or save the case." };
  }
  return { state: "idle", label: "no case running", detail: "Connect a headband to start a case." };
}
