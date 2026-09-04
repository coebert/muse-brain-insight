/**
 * Intake for our own hand-recorded cases.
 *
 * When a clinician logs a bedside monitor reading during a live case the app
 * writes a timeline annotation such as
 *
 *   BIS reference — BIS VISTA: BIS 46, SR 0 %, SEF 16 Hz (app 92)
 *
 * Most of those become paired readings straight away, but some never did:
 * epoch storage is capped per case, so readings taken late in a long case have
 * no stored epoch to attach to, and the pairing step skipped them. The
 * annotation itself still carries both numbers at the same instant, which is
 * exactly what a paired reading is, so this module recovers them.
 *
 * Nothing is invented here: a reading is only recovered when the annotation
 * records the app's own index alongside the monitor value. Annotations logged
 * while the app had no index are reported as unpairable, not guessed.
 */

/** One bedside reading recovered from a case timeline annotation. */
export interface InhouseAnnotationReading {
  eventId: string;
  sessionId: string;
  at: number;
  device: string;
  bis: number;
  bisSr: number | null;
  bisSef: number | null;
  appIndex: number;
}

export interface InhouseAnnotationEvent {
  id: string;
  session_id: string;
  t_offset_seconds: number;
  detail: string | null;
}

const PATTERN =
  /^BIS reference\s+—\s+([^:]+):\s+BIS\s+(\d+(?:\.\d+)?)(?:,\s*SR\s+(\d+(?:\.\d+)?)\s*%)?(?:,\s*SEF\s+(\d+(?:\.\d+)?)\s*Hz)?.*?\(app\s+(\d+(?:\.\d+)?)\)/;

/**
 * Parse a single timeline annotation. Returns null when the line is not a
 * bedside reference reading, or when it carries no app index to pair against.
 */
export function parseInhouseAnnotation(
  event: InhouseAnnotationEvent,
): InhouseAnnotationReading | null {
  const text = (event.detail ?? "").trim();
  if (!text.startsWith("BIS reference")) return null;
  const m = PATTERN.exec(text);
  if (!m) return null;
  const bis = Number(m[2]);
  const appIndex = Number(m[5]);
  if (!Number.isFinite(bis) || !Number.isFinite(appIndex)) return null;
  if (bis <= 0 || bis > 100 || appIndex < 0 || appIndex > 100) return null;
  return {
    eventId: event.id,
    sessionId: event.session_id,
    at: event.t_offset_seconds,
    device: (m[1] ?? "").trim() || "unknown monitor",
    bis,
    bisSr: m[3] != null ? Number(m[3]) : null,
    bisSef: m[4] != null ? Number(m[4]) : null,
    appIndex,
  };
}

/** Nearest stored epoch to a reading, when there is one close enough. */
export interface EpochSnapshot {
  sessionId: string;
  at: number;
  appIndex: number | null;
  appSr: number | null;
  appSef: number | null;
}

/** Widest gap, in seconds, at which a stored epoch may supply extra detail. */
export const INHOUSE_EPOCH_TOLERANCE = 10;

export function nearestEpoch(
  reading: InhouseAnnotationReading,
  epochs: EpochSnapshot[],
): EpochSnapshot | null {
  let best: EpochSnapshot | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const e of epochs) {
    if (e.sessionId !== reading.sessionId) continue;
    const gap = Math.abs(e.at - reading.at);
    if (gap < bestGap) {
      bestGap = gap;
      best = e;
    }
  }
  return bestGap <= INHOUSE_EPOCH_TOLERANCE ? best : null;
}

export interface InhousePairedRow {
  user_id: string;
  session_id: string;
  at_seconds: number;
  bis: number;
  bis_sr: number | null;
  bis_sef: number | null;
  app_index: number;
  app_sr: number | null;
  app_sef: number | null;
  reliable: boolean;
  sqi: number | null;
  context: string;
  device: string;
  source: string;
  source_lineage: string;
  external_ref: string;
  feature_source: string;
  lag_seconds: number;
  stability: string;
  depth_confidence: number;
}

export interface BuildRowOptions {
  userId: string;
  lineage: string;
  context: string;
  /** True when a signal-quality warning sits within half a minute of the reading. */
  qualityWarning?: boolean;
}

/**
 * Turn a recovered reading into a paired row. `external_ref` carries the
 * originating annotation id so a second run over the same case is a no-op.
 */
export function buildInhousePairedRow(
  reading: InhouseAnnotationReading,
  epoch: EpochSnapshot | null,
  opts: BuildRowOptions,
): InhousePairedRow {
  return {
    user_id: opts.userId,
    session_id: reading.sessionId,
    at_seconds: reading.at,
    bis: reading.bis,
    bis_sr: reading.bisSr,
    bis_sef: reading.bisSef,
    app_index: reading.appIndex,
    app_sr: epoch?.appSr ?? null,
    app_sef: epoch?.appSef ?? null,
    reliable: !opts.qualityWarning,
    sqi: null,
    context: opts.context,
    device: reading.device,
    source: "local",
    source_lineage: opts.lineage,
    external_ref: `inhouse-annotation:${reading.eventId}`,
    feature_source: epoch ? "epoch" : "annotation",
    lag_seconds: 0,
    stability: "stable",
    depth_confidence: epoch ? 1 : 0.7,
  };
}

export interface IntakeSurvey {
  events: number;
  parsed: number;
  unpairable: number;
  alreadyPaired: number;
  recovered: number;
  sessions: number;
}

/**
 * Decide which annotations are still missing a paired reading.
 * `pairedRefs` holds `external_ref` values already stored, `pairedTimes` the
 * `session_id|at` pairs stored by the original live pairing, which carried no
 * reference of their own.
 */
export function planInhouseIntake(
  events: InhouseAnnotationEvent[],
  pairedRefs: Set<string>,
  pairedTimes: (sessionId: string, at: number) => boolean,
): { readings: InhouseAnnotationReading[]; survey: IntakeSurvey } {
  const readings: InhouseAnnotationReading[] = [];
  let parsed = 0;
  let unpairable = 0;
  let alreadyPaired = 0;
  for (const e of events) {
    const text = (e.detail ?? "").trim();
    if (!text.startsWith("BIS reference")) continue;
    const reading = parseInhouseAnnotation(e);
    if (!reading) {
      unpairable++;
      continue;
    }
    parsed++;
    if (
      pairedRefs.has(`inhouse-annotation:${reading.eventId}`) ||
      pairedTimes(reading.sessionId, reading.at)
    ) {
      alreadyPaired++;
      continue;
    }
    readings.push(reading);
  }
  return {
    readings,
    survey: {
      events: events.length,
      parsed,
      unpairable,
      alreadyPaired,
      recovered: readings.length,
      sessions: new Set(readings.map((r) => r.sessionId)).size,
    },
  };
}
