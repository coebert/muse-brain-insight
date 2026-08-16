/**
 * When a paired commercial-BIS reading is worth asking for.
 *
 * COEBIS is data-limited, but not all readings are worth the same: another
 * reading at a steady BIS of 45 barely moves the fit, while one taken at
 * induction, at the first burst suppression, during emergence, or in the
 * middle of a large depth swing lands in a part of the scale the model has
 * almost nothing on. This module watches the live trend and decides when to
 * nudge, never more than one nudge at a time and never straight after a
 * reading has just been logged.
 */

export type CapturePromptKind =
  | "induction"
  | "suppression"
  | "emergence"
  | "swing"
  | "steady";

export interface CapturePrompt {
  kind: CapturePromptKind;
  /** Short bedside call to action. */
  title: string;
  /** One line on why this moment is worth a reading. */
  why: string;
  /** Higher wins when several moments coincide. */
  priority: number;
}

export interface CapturePromptInput {
  running: boolean;
  /** Case-clock seconds. */
  elapsed: number;
  depthIndex: number | null;
  suppressionRatio: number | null;
  /** Recent depth samples, oldest first: case-clock seconds and index. */
  trend: { t: number; index: number | null }[];
  /** Case clock of the most recent paired reading, if any. */
  lastReadingAt: number | null;
  /** Paired readings logged so far in this case. */
  readings: number;
}

/** Never nudge again within this many seconds of the last paired reading. */
export const PROMPT_QUIET_SECONDS = 240;
/** Induction window: the first few minutes of a case. */
const INDUCTION_SECONDS = 420;
/** Suppression above this is worth a reference reading. */
const SUPPRESSION_PROMPT = 5;
/** Index change over the look-back that counts as a large swing. */
const SWING_POINTS = 15;
const SWING_LOOKBACK_SECONDS = 180;
/** Steady-state top-up interval when nothing else is happening. */
const STEADY_INTERVAL_SECONDS = 900;

function indexAt(trend: CapturePromptInput["trend"], secondsAgo: number, now: number): number | null {
  const cutoff = now - secondsAgo;
  let best: number | null = null;
  for (const s of trend) {
    if (s.index == null || !Number.isFinite(s.index)) continue;
    if (s.t <= cutoff) best = s.index;
  }
  return best;
}

/**
 * The single most valuable capture prompt right now, or `null` when this is
 * not a moment worth interrupting for.
 */
export function evaluateCapturePrompt(input: CapturePromptInput): CapturePrompt | null {
  if (!input.running) return null;
  const { elapsed, lastReadingAt } = input;
  if (lastReadingAt != null && elapsed - lastReadingAt < PROMPT_QUIET_SECONDS) return null;

  const candidates: CapturePrompt[] = [];

  if (input.readings === 0 && elapsed >= 90 && elapsed <= INDUCTION_SECONDS) {
    candidates.push({
      kind: "induction",
      title: "Capture an induction reading",
      why: "Readings at induction cover the light end of the scale, where the model has least data.",
      priority: 4,
    });
  }

  if ((input.suppressionRatio ?? 0) >= SUPPRESSION_PROMPT) {
    candidates.push({
      kind: "suppression",
      title: "Capture during burst suppression",
      why: "Suppressed readings anchor the deep end, which is where open indices and BIS diverge most.",
      priority: 5,
    });
  }

  const earlier = indexAt(input.trend, SWING_LOOKBACK_SECONDS, elapsed);
  const now = input.depthIndex;
  if (earlier != null && now != null) {
    const change = now - earlier;
    if (Math.abs(change) >= SWING_POINTS) {
      const emerging = change > 0 && now >= 60;
      candidates.push(
        emerging
          ? {
              kind: "emergence",
              title: "Capture an emergence reading",
              why: "The index is climbing quickly — a paired value here tests the model where it matters clinically.",
              priority: 4,
            }
          : {
              kind: "swing",
              title: "Capture during this depth swing",
              why: `The index has moved ${Math.abs(Math.round(change))} points in three minutes; paired readings on the move are worth several at steady state.`,
              priority: 3,
            },
      );
    }
  }

  if (
    input.readings > 0 &&
    lastReadingAt != null &&
    elapsed - lastReadingAt >= STEADY_INTERVAL_SECONDS
  ) {
    candidates.push({
      kind: "steady",
      title: "Time for another paired reading",
      why: "It has been 15 minutes since the last comparison with the monitor.",
      priority: 1,
    });
  }

  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.priority - a.priority)[0]!;
}