/**
 * Hemisphere selection for the primary (whole-head) clinical metrics.
 *
 * The depth index (OpenIBIS), suppression ratio and SEF95 are normally derived
 * from the mean of all four Muse electrodes. When one side is clearly cleaner
 * than the other — a lifted TP electrode, unilateral EMG, sweat artefact — that
 * average drags good data down. In that case we derive the primary metrics from
 * the better hemisphere alone, exactly as bilateral processed-EEG monitors fall
 * back to the usable channel.
 *
 * Switching is hysteretic so the source cannot flap epoch to epoch: a side must
 * hold a clear advantage for a few consecutive epochs to take over, and the
 * advantage must decay well below that before both sides are used again.
 */

export type SideChoice = "left" | "right" | null;

/** Quality summary for one hemisphere's electrode pair. */
export interface SideQuality {
  /** 0–1 usability (worst electrode of the pair). */
  score: number;
  /** True when every electrode on the side is flat/disconnected. */
  flat: boolean;
  grade: "good" | "fair" | "poor";
}

/** Advantage needed to hand the primary metrics to one side. */
export const SIDE_TAKEOVER_MARGIN = 0.18;
/** Advantage below which both sides are used again. */
export const SIDE_RELEASE_MARGIN = 0.08;
/** Consecutive epochs the advantage must persist before switching. */
export const SIDE_TAKEOVER_EPOCHS = 3;

function effective(q: SideQuality): number {
  if (q.flat) return 0;
  return q.grade === "poor" ? Math.min(q.score, 0.2) : q.score;
}

export interface SideDecision {
  /** Side to use for the primary metrics, or null to use both. */
  side: SideChoice;
  /** Quality advantage of the better side (0–1). */
  advantage: number;
  /** Why the current source was chosen, for the UI. */
  reason: string;
}

export class SidePreference {
  private current: SideChoice = null;
  private candidate: SideChoice = null;
  private streak = 0;

  reset() {
    this.current = null;
    this.candidate = null;
    this.streak = 0;
  }

  /** Feeds one epoch of per-side quality and returns the source to analyse. */
  update(left: SideQuality, right: SideQuality): SideDecision {
    const l = effective(left);
    const r = effective(right);
    const better: SideChoice = l === r ? null : l > r ? "left" : "right";
    const advantage = Math.abs(l - r);

    if (this.current) {
      // Give up the single-side source once the sides converge again, or the
      // held side stops being the better one.
      const held = this.current === "left" ? l : r;
      const other = this.current === "left" ? r : l;
      if (held - other < SIDE_RELEASE_MARGIN) {
        this.current = null;
        this.candidate = null;
        this.streak = 0;
      }
    }

    if (!this.current) {
      if (better && advantage >= SIDE_TAKEOVER_MARGIN) {
        if (this.candidate === better) this.streak++;
        else {
          this.candidate = better;
          this.streak = 1;
        }
        if (this.streak >= SIDE_TAKEOVER_EPOCHS) {
          this.current = better;
          this.candidate = null;
          this.streak = 0;
        }
      } else {
        this.candidate = null;
        this.streak = 0;
      }
    }

    const side = this.current;
    const reason = side
      ? `${side === "left" ? "Left" : "Right"} hemisphere is ${Math.round(advantage * 100)}% cleaner — primary metrics use this side only`
      : "Both hemispheres usable — primary metrics use the four-electrode average";
    return { side, advantage, reason };
  }
}
