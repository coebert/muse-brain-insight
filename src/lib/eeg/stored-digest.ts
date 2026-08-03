/**
 * Builds an AI digest for a SAVED session from stored epoch/event rows, so the
 * same clinical reviewer can be run retrospectively on any recorded case.
 */

export interface StoredEpochPoint {
  t: number;
  depth: number | null;
  sef95: number | null;
  sr: number | null;
  seizure: number | null;
  cIndex: number | null;
  nIndex: number | null;
  /** State entropy as a percentage (0-100), matching the trends view. */
  entropy: number | null;
  suppressed: number;
}

export interface StoredEventPoint {
  t: number;
  kind: string;
  severity: string;
  detail: string;
}

export interface StoredSessionMeta {
  caseCode: string;
  context: string;
  ageBand: string | null;
  sex: string | null;
  admissionDiagnosis: string | null;
  clinicalFeatures: string[];
  notes: string | null;
  durationSeconds: number;
}

type Key = keyof Pick<
  StoredEpochPoint,
  "depth" | "sef95" | "sr" | "seizure" | "cIndex" | "nIndex" | "entropy"
>;

const METRIC_LABELS: Record<Key, string> = {
  depth: "depthIndex",
  sef95: "sef95Hz",
  sr: "suppressionRatioPct",
  seizure: "seizureScore",
  cIndex: "consciousnessIndex",
  nIndex: "nociceptionIndex",
  entropy: "stateEntropyPct",
};

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function round(v: number | null, dp = 1): number | null {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp));
}

function values(rows: StoredEpochPoint[], key: Key): number[] {
  return rows.map((r) => r[key]).filter((v): v is number => typeof v === "number");
}

function slopePerHour(rows: StoredEpochPoint[], key: Key): number | null {
  const pts = rows
    .filter((r) => typeof r[key] === "number")
    .map((r) => ({ t: r.t, y: r[key] as number }));
  if (pts.length < 3) return null;
  const mt = mean(pts.map((p) => p.t))!;
  const my = mean(pts.map((p) => p.y))!;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.y - my);
    den += (p.t - mt) ** 2;
  }
  return den ? round((num / den) * 3600, 2) : null;
}

function segmentStats(rows: StoredEpochPoint[]) {
  return {
    meanDepth: round(mean(values(rows, "depth")), 0),
    meanSef95: round(mean(values(rows, "sef95")), 1),
    meanSuppressionPct: round(mean(values(rows, "sr")), 1),
    meanSeizureScore: round(mean(values(rows, "seizure")), 2),
    meanNociception: round(mean(values(rows, "nIndex")), 0),
    meanConsciousness: round(mean(values(rows, "cIndex")), 0),
  };
}

export function buildStoredDigest(
  rows: StoredEpochPoint[],
  events: StoredEventPoint[],
  meta: StoredSessionMeta,
) {
  const markers = events.filter((e) => e.kind === "annotation").sort((a, b) => a.t - b.t);
  const cadence =
    rows.length > 1
      ? Math.max(0.1, (rows[rows.length - 1]!.t - rows[0]!.t) / (rows.length - 1))
      : 1;
  const third = Math.max(1, Math.floor(rows.length / 3));

  const markerResponses = markers.map((m) => {
    const pre = rows.filter((r) => r.t >= m.t - 60 && r.t < m.t);
    const post = rows.filter((r) => r.t > m.t && r.t <= m.t + 120);
    return {
      tSeconds: Math.round(m.t),
      label: m.detail,
      beforeEpochs: pre.length,
      afterEpochs: post.length,
      deltas: (Object.keys(METRIC_LABELS) as Key[]).map((k) => {
        const dp = k === "seizure" ? 2 : k === "depth" || k === "nIndex" || k === "cIndex" ? 0 : 1;
        const b = round(mean(values(pre, k)), dp);
        const a = round(mean(values(post, k)), dp);
        return {
          metric: METRIC_LABELS[k],
          before: b,
          after: a,
          change: b != null && a != null ? round(a - b, dp) : null,
        };
      }),
      followedBy: events
        .filter((e) => e.kind !== "annotation" && e.t > m.t && e.t <= m.t + 120)
        .slice(0, 5)
        .map((e) => ({
          kind: e.kind,
          severity: e.severity,
          tSeconds: Math.round(e.t),
          detail: e.detail,
        })),
    };
  });

  const bounds = [0, ...markers.map((m) => m.t), rows.length ? rows[rows.length - 1]!.t : 0];
  const labels = ["session start", ...markers.map((m) => m.detail)];
  const markerPhases = [] as unknown[];
  for (let i = 0; i < bounds.length - 1; i++) {
    const seg = rows.filter((r) => r.t >= bounds[i]! && r.t < bounds[i + 1]!);
    if (seg.length < 2) continue;
    markerPhases.push({
      fromLabel: labels[i] ?? "segment",
      tStartSeconds: Math.round(bounds[i]!),
      tEndSeconds: Math.round(bounds[i + 1]!),
      ...segmentStats(seg),
    });
  }

  const step = Math.max(1, Math.floor(rows.length / 40));
  const timeline = rows
    .filter((_, i) => i % step === 0)
    .map((r) => ({
      tSeconds: Math.round(r.t),
      srPct: round(r.sr, 1),
      sef95: round(r.sef95, 1),
      seizureScore: round(r.seizure, 2),
      depthIndex: round(r.depth, 0),
    }));

  const srVals = values(rows, "sr");
  const seizureVals = values(rows, "seizure");
  const depthVals = values(rows, "depth");

  return {
    source: "saved_session",
    mode: meta.context,
    durationSeconds: Math.round(meta.durationSeconds),
    epochCount: rows.length,
    epochCadenceSeconds: round(cadence, 2),
    patient: {
      ageBand: meta.ageBand,
      sex: meta.sex,
      admissionDiagnosis: meta.admissionDiagnosis,
      clinicalFeatures: meta.clinicalFeatures,
      clinicalContext: meta.context,
      notes: meta.notes,
    },
    suppression: {
      meanRatioPct: round(mean(srVals), 1),
      maxRatioPct: srVals.length ? round(Math.max(...srVals), 1) : null,
      suppressedSeconds: round(rows.filter((r) => r.suppressed).length * cadence, 1),
      burstSuppressionEvents: events.filter((e) => e.kind === "burst_suppression").length,
      isoelectricEvents: events.filter((e) => e.kind === "isoelectric").length,
    },
    seizure: {
      alerts: events.filter((e) => e.kind === "seizure").length,
      meanScore: round(mean(seizureVals), 2),
      maxScore: seizureVals.length ? round(Math.max(...seizureVals), 2) : null,
      fractionAboveHalf: seizureVals.length
        ? round(seizureVals.filter((v) => v > 0.5).length / seizureVals.length, 2)
        : 0,
    },
    depthIndex: {
      mean: round(mean(depthVals), 0),
      min: depthVals.length ? Math.min(...depthVals) : null,
      max: depthVals.length ? Math.max(...depthVals) : null,
      latest: depthVals.length ? depthVals[depthVals.length - 1]! : null,
      fractionBelow40: depthVals.length
        ? round(depthVals.filter((v) => v < 40).length / depthVals.length, 2)
        : 0,
      // Retrospective review of stored epochs: per-epoch gating detail is not
      // persisted, so treat reliability as unknown rather than assured.
      reliableFraction: null,
      note: "Stored session — per-epoch artefact gating detail is not retained; judge reliability from the trend's plausibility and coherence between indices.",
    },
    compositeIndex: {
      meanConsciousness: round(mean(values(rows, "cIndex")), 0),
      meanNociception: round(mean(values(rows, "nIndex")), 0),
    },
    spectral: {
      meanSef95Hz: round(mean(values(rows, "sef95")), 1),
      sef95TrendHzPerHour: slopePerHour(rows, "sef95"),
      depthTrendPerHour: slopePerHour(rows, "depth"),
      meanStateEntropyPct: round(mean(values(rows, "entropy")), 1),
      firstThird: segmentStats(rows.slice(0, third)),
      lastThird: segmentStats(rows.slice(-third)),
    },
    annotations: markers.map((m) => ({ tSeconds: Math.round(m.t), label: m.detail })),
    markerResponses,
    markerPhases,
    detectedEvents: events
      .filter((e) => e.kind !== "annotation")
      .slice(-25)
      .map((e) => ({
        tSeconds: Math.round(e.t),
        kind: e.kind,
        severity: e.severity,
        detail: e.detail,
      })),
    timeline,
  };
}
