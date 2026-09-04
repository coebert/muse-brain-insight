import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { MIN_POINTS, MIN_SESSIONS } from "@/lib/eeg/bis-drift";
import {
  trainingSummary,
  versionVerdict,
  type VersionMetrics,
} from "@/lib/eeg/coebis-version-history";

export interface CoebisModelVersionRow {
  lineageKey: string;
  version: number;
  family: string;
  promoted: boolean;
  isActive: boolean;
  reason: string | null;
  maeGain: number | null;
  before: VersionMetrics;
  after: VersionMetrics;
  training: {
    n: number;
    cases: number;
    folds: number;
    passRate: number | null;
    firstReadingAt: string | null;
    lastReadingAt: string | null;
  };
  createdAt: string;
  /** Gate check restated from the stored training counts — never re-derived. */
  gate: {
    cleared: boolean;
    points: { have: number; need: number };
    cases: { have: number; need: number };
  };
  verdict: string;
  trainingText: string;
}

export interface CoebisModelLineage {
  lineageKey: string;
  versions: CoebisModelVersionRow[];
  activeVersion: number | null;
  latestVersion: number;
}

export interface CoebisModelCatalog {
  lineages: CoebisModelLineage[];
  totalVersions: number;
  gate: { minPoints: number; minCases: number };
  generatedAt: string;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function metricsOf(raw: unknown): VersionMetrics {
  const m = (raw ?? {}) as Record<string, unknown>;
  return {
    mae: num(m["mae"]),
    bias: num(m["bias"]),
    ccc: num(m["ccc"]),
    n: num(m["n"]) ?? undefined,
    source: typeof m["source"] === "string" ? (m["source"] as string) : undefined,
  };
}

/**
 * Every stored COEBIS model version, grouped by acquisition lineage, with its
 * held-out metrics and the gate status restated from the recorded training
 * counts. Read-only audit view — nothing here refits or promotes.
 */
export const getCoebisModelCatalog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CoebisModelCatalog> => {
    const { data, error } = await context.supabase
      .from("coebis_model_versions")
      .select(
        "lineage_key, version, model_family, promoted, is_active, reason, mae_gain, metrics_before, metrics_after, training, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const byLineage = new Map<string, CoebisModelVersionRow[]>();
    let total = 0;

    for (const raw of (data ?? []) as unknown as Record<string, unknown>[]) {
      const t = (raw["training"] ?? {}) as Record<string, unknown>;
      const n = num(t["n"]) ?? 0;
      const cases = num(t["cases"]) ?? 0;
      const before = metricsOf(raw["metrics_before"]);
      const after = metricsOf(raw["metrics_after"]);
      const promoted = raw["promoted"] === true;
      const isActive = raw["is_active"] === true;
      const maeGain = num(raw["mae_gain"]);

      const row: CoebisModelVersionRow = {
        lineageKey: String(raw["lineage_key"]),
        version: Number(raw["version"]),
        family: String(raw["model_family"] ?? "covariate"),
        promoted,
        isActive,
        reason: (raw["reason"] as string | null) ?? null,
        maeGain,
        before,
        after,
        training: {
          n,
          cases,
          folds: num(t["folds"]) ?? 0,
          passRate: num(t["passRate"]),
          firstReadingAt: (t["firstReadingAt"] as string | null) ?? null,
          lastReadingAt: (t["lastReadingAt"] as string | null) ?? null,
        },
        createdAt: String(raw["created_at"]),
        gate: {
          cleared: n >= MIN_POINTS && cases >= MIN_SESSIONS,
          points: { have: n, need: MIN_POINTS },
          cases: { have: cases, need: MIN_SESSIONS },
        },
        verdict: versionVerdict({ promoted, isActive, maeGain, before, after }),
        trainingText: trainingSummary({
          n,
          cases,
          folds: num(t["folds"]) ?? 0,
          passRate: num(t["passRate"]) ?? undefined,
        }),
      };

      const list = byLineage.get(row.lineageKey) ?? [];
      list.push(row);
      byLineage.set(row.lineageKey, list);
      total++;
    }

    const lineages: CoebisModelLineage[] = [...byLineage.entries()]
      .map(([lineageKey, versions]) => {
        versions.sort((a, b) => b.version - a.version);
        const active = versions.find((v) => v.isActive);
        return {
          lineageKey,
          versions,
          activeVersion: active?.version ?? null,
          latestVersion: versions[0]?.version ?? 0,
        };
      })
      .sort((a, b) => a.lineageKey.localeCompare(b.lineageKey));

    return {
      lineages,
      totalVersions: total,
      gate: { minPoints: MIN_POINTS, minCases: MIN_SESSIONS },
      generatedAt: new Date().toISOString(),
    };
  });
