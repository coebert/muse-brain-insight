import { useEffect, useRef, useState } from "react";

/**
 * Sanity check on the headband's reported charge. The Muse answers the status
 * command with a JSON fragment that can arrive truncated or interleaved, so a
 * mis-parsed reply can look like a sudden battery cliff (or a jump back up).
 * Rather than alarm on nonsense, the reading is graded and flagged.
 */

export interface BatteryReading {
  /** Wall-clock milliseconds when the value was received. */
  t: number;
  percent: number;
}

export type BatteryHealthStatus = "unknown" | "ok" | "suspect" | "unreliable";

export interface BatteryHealth {
  status: BatteryHealthStatus;
  /** Plain-language explanation for the clinician. */
  reason: string;
  /** Number of implausible transitions seen this session. */
  anomalies: number;
  /** Best estimate of true charge: the last reading that passed the checks. */
  trusted: number | null;
}

/** A charge cannot fall faster than this without something being wrong. */
export const MAX_DROP_PER_MINUTE = 8;
/** A headband on a patient does not charge; any meaningful rise is suspect. */
export const MAX_RISE = 3;
/** Readings closer than this are treated as one sample. */
const MIN_INTERVAL_MS = 1000;
/** Two or more anomalies means the parse itself is untrustworthy. */
const UNRELIABLE_AT = 2;

function outOfRange(percent: number) {
  return !Number.isFinite(percent) || percent < 0 || percent > 100;
}

/**
 * Grades a series of readings, newest last. Pure so it can be unit-tested and
 * replayed over a stored session.
 */
export function assessBatteryHealth(readings: BatteryReading[]): BatteryHealth {
  const usable = readings.filter((r) => r.t > 0);
  if (usable.length === 0) {
    return { status: "unknown", reason: "No battery reading yet.", anomalies: 0, trusted: null };
  }

  let anomalies = 0;
  let lastReason = "";
  let trusted: number | null = null;
  let previous: BatteryReading | null = null;

  for (const reading of usable) {
    if (outOfRange(reading.percent)) {
      anomalies++;
      lastReason = `A reading of ${reading.percent}% is outside the 0–100% range.`;
      continue;
    }
    if (previous && reading.t - previous.t >= MIN_INTERVAL_MS) {
      const minutes = (reading.t - previous.t) / 60_000;
      const delta = reading.percent - previous.percent;
      if (delta > MAX_RISE) {
        anomalies++;
        lastReason = `Charge rose ${Math.round(delta)} points (${previous.percent}% → ${reading.percent}%) without the headband being on charge.`;
        continue;
      }
      const maxDrop = Math.max(MAX_DROP_PER_MINUTE * minutes, MAX_DROP_PER_MINUTE / 2);
      if (-delta > maxDrop) {
        anomalies++;
        lastReason = `Charge fell ${Math.round(-delta)} points in ${Math.round((reading.t - previous.t) / 1000)}s (${previous.percent}% → ${reading.percent}%), faster than the battery can discharge.`;
        continue;
      }
    }
    trusted = reading.percent;
    previous = reading;
  }

  if (anomalies >= UNRELIABLE_AT) {
    return {
      status: "unreliable",
      reason: `${anomalies} implausible battery readings — the headband's status replies are probably being mis-read. Treat the percentage as indicative only.`,
      anomalies,
      trusted,
    };
  }
  if (anomalies === 1) {
    return {
      status: "suspect",
      reason: `${lastReason} Showing the last plausible value.`,
      anomalies,
      trusted,
    };
  }
  return { status: "ok", reason: "Battery readings are consistent.", anomalies, trusted };
}

/** Rolling window kept in memory; a case rarely needs more than this. */
const MAX_READINGS = 240;

/**
 * Records each reported charge and grades the series. Returns the health plus
 * the value that should actually be displayed.
 */
export function useBatteryHealth(percent: number | null): BatteryHealth & { display: number | null } {
  const readings = useRef<BatteryReading[]>([]);
  const [health, setHealth] = useState<BatteryHealth>({
    status: "unknown",
    reason: "No battery reading yet.",
    anomalies: 0,
    trusted: null,
  });

  useEffect(() => {
    if (percent == null) {
      readings.current = [];
      setHealth({ status: "unknown", reason: "No battery reading yet.", anomalies: 0, trusted: null });
      return;
    }
    readings.current = [...readings.current, { t: Date.now(), percent }].slice(-MAX_READINGS);
    setHealth(assessBatteryHealth(readings.current));
  }, [percent]);

  const display =
    health.status === "unknown"
      ? percent
      : health.status === "ok"
        ? percent
        : (health.trusted ?? percent);

  return { ...health, display };
}
