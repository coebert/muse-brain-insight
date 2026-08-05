import type { AlarmCondition } from "@/hooks/useAlarms";
import type { HemiLatest } from "@/hooks/useEegMonitor";
import type { Epoch } from "@/lib/eeg/analysis";
import { SIDE_LABEL, type AlarmSide } from "@/lib/eeg/alarms";

export interface AlarmDerivationInput {
  latest: Epoch | null;
  hemi: HemiLatest | null;
  /** ICU mode escalates ictal alarms from medium to high priority. */
  icuMode: boolean;
  /** Suppression ratio (%) at which a medium-priority alarm is raised. */
  bsrAlertPercent: number;
  /** Seconds since the last usable sample arrived. */
  dataGapSeconds: number;
  reconnecting: boolean;
  reconnectAttempt?: { attempt: number; attempts: number } | null;
}

/** Deep suppression always outranks the clinician's own alert threshold. */
const DEEP_SUPPRESSION_PERCENT = 40;
/** A whole-headband dropout of this length is treated as signal loss. */
const SIGNAL_LOSS_SECONDS = 5;

/**
 * Pure translation of the live epoch, hemisphere metrics and stream health
 * into bedside alarm conditions. Kept out of the dashboard component so the
 * clinical rules can be unit-tested in isolation.
 */
export function deriveAlarmConditions(input: AlarmDerivationInput): AlarmCondition[] {
  const { latest, hemi, icuMode, bsrAlertPercent, dataGapSeconds, reconnecting } = input;
  const conditions: AlarmCondition[] = [];

  // Seizure: attribute to the hemisphere whose electrode pair is ictal.
  if (latest?.seizureAlert || hemi?.left.seizureAlert || hemi?.right.seizureAlert) {
    const sides: AlarmSide[] =
      hemi && (hemi.left.seizureAlert || hemi.right.seizureAlert)
        ? hemi.left.seizureAlert && hemi.right.seizureAlert
          ? ["bilateral"]
          : hemi.left.seizureAlert
            ? ["left"]
            : ["right"]
        : ["bilateral"];
    for (const side of sides) {
      const score =
        side === "left"
          ? (hemi?.left.seizureScore ?? 0)
          : side === "right"
            ? (hemi?.right.seizureScore ?? 0)
            : (latest?.seizureScore ?? 0);
      conditions.push({
        id: `seizure:${side}`,
        side,
        priority: icuMode ? "high" : "medium",
        title: `Possible seizure activity — ${SIDE_LABEL[side]}`,
        detail: `Rhythmic discharges, score ${score.toFixed(2)} — review the raw trace.`,
      });
    }
  }

  // Suppression: raise one alarm per side that crosses the threshold.
  const srBySide: { side: AlarmSide; sr: number }[] = hemi
    ? [
        { side: "left", sr: hemi.left.suppressionRatio },
        { side: "right", sr: hemi.right.suppressionRatio },
      ]
    : latest
      ? [{ side: "bilateral", sr: latest.suppressionRatio }]
      : [];
  for (const { side, sr } of srBySide) {
    if (sr >= DEEP_SUPPRESSION_PERCENT) {
      conditions.push({
        id: `deep-suppression:${side}`,
        side,
        priority: "high",
        title: `Deep burst suppression — ${SIDE_LABEL[side]}`,
        detail: `Suppression ratio ${sr.toFixed(0)} % — consider lightening.`,
      });
    } else if (sr >= bsrAlertPercent) {
      conditions.push({
        id: `suppression:${side}`,
        side,
        priority: "medium",
        title: `Burst suppression — ${SIDE_LABEL[side]}`,
        detail: `Suppression ratio ${sr.toFixed(0)} %.`,
      });
    }
  }

  // Signal loss: a whole-headband gap is bilateral, a flat pair is one side.
  if (dataGapSeconds >= SIGNAL_LOSS_SECONDS || reconnecting) {
    conditions.push({
      id: "signal-loss:bilateral",
      side: "bilateral",
      priority: "medium",
      title: "EEG signal lost — both hemispheres",
      detail: reconnecting
        ? `Reconnecting to the headband (attempt ${input.reconnectAttempt?.attempt ?? 1} of ${
            input.reconnectAttempt?.attempts ?? 5
          }).`
        : `No data for ${Math.round(dataGapSeconds)} s — check the headband.`,
    });
  } else if (hemi) {
    for (const side of ["left", "right"] as const) {
      if (hemi[side].flat) {
        conditions.push({
          id: `signal-loss:${side}`,
          side,
          priority: "medium",
          title: `EEG signal lost — ${SIDE_LABEL[side]}`,
          detail: "Both electrodes on this side are flat — reseat the headband.",
        });
      }
    }
  }

  if (latest && !latest.depthReliability.reliable && latest.quality.grade === "poor") {
    conditions.push({
      id: "quality",
      priority: "low",
      title: "Poor signal quality",
      detail: latest.depthReliability.reasons[0] ?? "Indices are unreliable in this segment.",
    });
  }

  return conditions;
}
