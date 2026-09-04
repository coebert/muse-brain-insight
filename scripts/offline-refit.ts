/**
 * Offline COEBIS refit: runs the exact app pipeline (validation gate, plan,
 * per-lineage refit with case-aware CV and promotion rules) against a full
 * database dump, and emits the rows to persist. Mirrors runRefitForUser.
 */
import { readFileSync, writeFileSync } from "fs";

import type { CoebisTrainingPoint } from "../src/lib/eeg/coebis-covariates";
import {
  MAX_LINEAGES_PER_RUN,
  planRefit,
  refitLineage,
  selectValidatedPoints,
  summariseRun,
  type LineageRefit,
} from "../src/lib/eeg/coebis-refit";
import { modelFromRow } from "../src/lib/eeg/coebis-refit.server";

const DIR = "/tmp/browser/vitaldb-intake";
const rows = JSON.parse(readFileSync(`${DIR}/points.json`, "utf8")) as Record<string, unknown>[];
const versions = JSON.parse(readFileSync(`${DIR}/versions.json`, "utf8")) as Record<string, unknown>[];

const points: CoebisTrainingPoint[] = rows.map((r) => {
  const features = (r["features"] as Record<string, unknown> | null) ?? null;
  const rawSessionId = (r["session_id"] as string | null) ?? null;
  const imported = !rawSessionId && features?.["imported"] === true;
  const sessionId = rawSessionId ?? (imported ? `import:${String(features?.["caseRef"] ?? "?")}` : null);
  return {
    at: Number(r["at_seconds"]),
    bis: Number(r["bis"]),
    appIndex: Number(r["app_index"]),
    appSr: r["app_sr"] == null ? null : Number(r["app_sr"]),
    sessionId,
    reliable: Boolean(r["reliable"]),
    sqi: r["sqi"] == null ? null : Number(r["sqi"]),
    depthConfidence: r["depth_confidence"] == null ? null : Number(r["depth_confidence"]),
    recordedAt: String(r["recorded_at"]),
    context: (r["context"] as string | null) ?? null,
    ce: (r["ce"] as Record<string, number> | null) ?? null,
    lineageKey: (r["source_lineage"] as string | null) ?? null,
    cov: {
      ageBand: (features?.["ageBand"] as string | null) ?? null,
      sex: (features?.["sex"] as string | null) ?? null,
      regimen: (features?.["regimen"] as string | null) ?? null,
      frailty: (features?.["frailty"] as string | null) ?? null,
      chronicBurden: null,
      chronicCns: null,
      acuteClass: null,
    },
  };
}).filter((p) => Number.isFinite(p.bis) && Number.isFinite(p.appIndex));

const validated = selectValidatedPoints(points);

const lastDigests: Record<string, string | null> = {};
const maxVersion = new Map<string, number>();
const incumbents = new Map<string, ReturnType<typeof modelFromRow>>();
for (const row of versions) {
  const key = String(row["lineage_key"]);
  if (!(key in lastDigests)) lastDigests[key] = String(row["data_digest"]);
  maxVersion.set(key, Number(row["version"]));
  if (row["is_active"] && !incumbents.has(key)) incumbents.set(key, modelFromRow(row));
}
// Full per-lineage version maxima (the dump is DISTINCT ON lineage, so ask again below)
// — filled by the caller via maxima.json.
const maxima = JSON.parse(readFileSync(`${DIR}/maxima.json`, "utf8")) as Record<string, number>;
for (const [k, v] of Object.entries(maxima)) maxVersion.set(k, v);

const plan = planRefit(validated.used, lastDigests, MAX_LINEAGES_PER_RUN);
const out = {
  validatedPoints: validated.used.length,
  rejected: validated.rejected,
  considered: plan.entries.length + plan.deferred.length + plan.skippedUnchanged.length,
  skippedUnchanged: plan.skippedUnchanged,
  deferred: plan.deferred.map((d) => d.lineageKey),
  results: [] as unknown[],
};

for (const entry of plan.entries) {
  const result = refitLineage(entry.lineageKey, entry.points, incumbents.get(entry.lineageKey) ?? null);
  const version = result.model ? (maxVersion.get(entry.lineageKey) ?? 0) + 1 : null;
  const times = entry.points.map((p) => p.recordedAt).sort();
  out.results.push({
    lineageKey: entry.lineageKey,
    version,
    n: result.n,
    cases: result.cases,
    promoted: result.promote,
    reason: result.reason,
    maeGain: result.maeGain,
    folds: result.folds,
    before: result.before,
    after: result.after,
    beforeSource: result.beforeSource,
    row: result.model
      ? {
          version,
          model_family: result.family,
          coefficients: {
            gain: result.model.gain,
            offset: result.model.offset,
            knots: result.model.knots,
            terms: result.model.terms,
            ceTerms: result.model.ceTerms,
            n: result.model.n,
            sessions: result.model.sessions,
          },
          training: {
            n: result.n,
            cases: result.cases,
            folds: result.folds,
            lineageKey: entry.lineageKey,
            sessions: new Set(entry.points.map((p) => p.sessionId).filter(Boolean)).size,
            firstReadingAt: times[0] ?? null,
            lastReadingAt: times[times.length - 1] ?? null,
          },
          metrics_before: { ...result.before, source: result.beforeSource },
          metrics_after: result.after,
          mae_gain: result.maeGain,
          promoted: result.promote,
          is_active: result.promote,
          reason: result.reason,
          data_digest: result.digest,
        }
      : null,
  });
}

const summary = summariseRun(
  out.results.map((d) => ({ ...(d as object), promote: (d as { promoted: boolean }).promoted }) as unknown as LineageRefit),
);
writeFileSync(`${DIR}/refit.json`, JSON.stringify({ ...out, summary }, null, 2));
console.log(summary);
for (const r of out.results as { lineageKey: string; promoted: boolean; reason: string }[]) {
  console.log(`- ${r.lineageKey}: ${r.promoted ? "PROMOTED" : "not promoted"} — ${r.reason}`);
}
