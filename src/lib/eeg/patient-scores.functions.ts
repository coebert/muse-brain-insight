import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildPatientRows,
  summarisePatientCohort,
  type PatientCohort,
  type PatientLineageModel,
  type PatientReadingInput,
  type ReferenceKind,
} from "@/lib/eeg/patient-scores";

/** Rows read per page; the data API caps a single response at 1000. */
const PAGE = 1000;
const MAX_ROWS = 20000;

const REFERENCE_KINDS = new Set<ReferenceKind>(["monitor", "moaas-score", "event-state"]);

/**
 * Every case the app has paired readings for, with its COEBIS scores,
 * suppression burden, spectral edge and age, against whatever reference that
 * case was recorded with.
 */
export const getPatientScores = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientCohort & { generatedAt: string }> => {
    const { open } = await import("@/lib/privacy.server");
    const { modelFromRow } = await import("@/lib/eeg/coebis-refit.server");

    const rows: Record<string, unknown>[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await context.supabase
        .from("bis_paired_points")
        .select(
          "at_seconds, recorded_at, bis, bis_sr, bis_sef, app_index, app_sr, app_sef, reliable, session_id, source_lineage, device, source, features, ce",
        )
        .order("recorded_at", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as unknown as Record<string, unknown>[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }

    // Case covariates for locally recorded cases; imported cases carry their
    // own pseudonymous ref and whatever the dataset published.
    const sessionIds = [
      ...new Set(rows.map((r) => r["session_id"]).filter((v): v is string => typeof v === "string")),
    ];
    const sessions = new Map<string, Record<string, unknown>>();
    if (sessionIds.length) {
      const { data } = await context.supabase
        .from("eeg_sessions")
        .select(
          "id, case_code, age_years, age_band, sex, regimen, frailty, chronic_burden, chronic_cns, acute_class",
        )
        .in("id", sessionIds.slice(0, 500));
      for (const s of (data ?? []) as unknown as Record<string, unknown>[]) {
        sessions.set(String(s["id"]), s);
      }
    }

    const { data: versionRows } = await context.supabase
      .from("coebis_model_versions")
      .select("lineage_key, version, model_family, coefficients, is_active")
      .eq("is_active", true)
      .order("version", { ascending: false });
    const models = new Map<string, PatientLineageModel>();
    for (const row of (versionRows ?? []) as unknown as Record<string, unknown>[]) {
      const key = String(row["lineage_key"]);
      if (models.has(key)) continue;
      const model = modelFromRow(row);
      if (model) models.set(key, { model, version: Number(row["version"]) });
    }

    const num = (v: unknown): number | null =>
      v == null || !Number.isFinite(Number(v)) ? null : Number(v);

    const readings: PatientReadingInput[] = rows.map((r) => {
      const features = (r["features"] as Record<string, unknown> | null) ?? null;
      const sessionId = (r["session_id"] as string | null) ?? null;
      const session = sessionId ? sessions.get(sessionId) : undefined;
      const caseRef = features?.["caseRef"] == null ? null : String(features["caseRef"]);
      const caseKey = sessionId ?? (caseRef ? `import:${caseRef}` : "unfiled");
      const caseLabel = session
        ? (open(String(session["case_code"] ?? "")) ?? "unlabelled")
        : (caseRef ?? "unfiled readings");

      const rawKind = features?.["referenceKind"] == null ? null : String(features["referenceKind"]);
      const referenceKind: ReferenceKind =
        rawKind && REFERENCE_KINDS.has(rawKind as ReferenceKind)
          ? (rawKind as ReferenceKind)
          : sessionId
            ? "monitor"
            : "unknown";

      return {
        caseKey,
        caseLabel,
        lineageKey: (r["source_lineage"] as string | null) ?? null,
        recordedAt: String(r["recorded_at"]),
        at: Number(r["at_seconds"]),
        reference: Number(r["bis"]),
        appIndex: Number(r["app_index"]),
        appSr: num(r["app_sr"]),
        appSef: num(r["app_sef"]),
        refSr: num(r["bis_sr"]),
        refSef: num(r["bis_sef"]),
        reliable: Boolean(r["reliable"]),
        referenceKind,
        monitor: (r["device"] as string | null) ?? (r["source"] as string | null) ?? null,
        ageYears: session ? num(session["age_years"]) : null,
        cov: {
          ageBand: (session?.["age_band"] as string | null) ?? (features?.["ageBand"] as string | null) ?? null,
          sex: (session?.["sex"] as string | null) ?? (features?.["sex"] as string | null) ?? null,
          regimen:
            (session?.["regimen"] as string | null) ?? (features?.["regimen"] as string | null) ?? null,
          frailty: (session?.["frailty"] as string | null) ?? null,
          chronicBurden: (session?.["chronic_burden"] as string | null) ?? null,
          chronicCns: (session?.["chronic_cns"] as string | null) ?? null,
          acuteClass: (session?.["acute_class"] as string | null) ?? null,
        },
        ce: (r["ce"] as Record<string, number> | null) ?? null,
      } satisfies PatientReadingInput;
    });

    const cohort = summarisePatientCohort(buildPatientRows(readings, models));
    return { ...cohort, generatedAt: new Date().toISOString() };
  });
