/**
 * Server-only helpers for prospective validation (Phase 6).
 *
 * Locking a model freezes its coefficients and the moment it was locked. Every
 * paired reading recorded afterwards is, by construction, data the model has
 * never been fitted on — the only honest way to claim prospective agreement.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { CoebisModel, CoebisTrainingPoint } from "./coebis-covariates";
import type { CovariateTerm } from "./covariates";

type Client = SupabaseClient<any, any, any>;

export interface CoebisLock {
  id: string;
  label: string;
  note: string | null;
  lockedAt: string;
  modelVersion: number | null;
  modelFamily: string;
  isActive: boolean;
  model: CoebisModel;
}

function toTerms(value: unknown): CovariateTerm[] {
  const raw = (value as { terms?: unknown } | null)?.terms;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => t as Partial<CovariateTerm>)
    .filter((t) => typeof t?.group === "string" && typeof t?.level === "string")
    .map((t) => ({
      group: String(t.group),
      level: String(t.level),
      dy: Number(t.dy) || 0,
      n: Number(t.n) || 0,
    }));
}

export function rowToLock(row: Record<string, unknown>): CoebisLock {
  const coefficients = row["coefficients"] as Record<string, unknown> | null;
  const family = String(row["model_family"] ?? "affine");
  return {
    id: String(row["id"]),
    label: String(row["label"] ?? ""),
    note: (row["note"] as string | null) ?? null,
    lockedAt: String(row["locked_at"]),
    modelVersion: row["model_version"] == null ? null : Number(row["model_version"]),
    modelFamily: family,
    isActive: Boolean(row["is_active"]),
    model: {
      family: (family === "mixed" ? "covariate" : family) as CoebisModel["family"],
      gain: Number((coefficients?.["gain"] as number) ?? 1),
      offset: Number((coefficients?.["offset"] as number) ?? 0),
      knots: Array.isArray(coefficients?.["knots"])
        ? (coefficients!["knots"] as { x: number; dy: number }[])
        : [],
      terms: toTerms(coefficients),
      caseIntercepts: {},
      n: Number((coefficients?.["n"] as number) ?? 0),
      sessions: Number((coefficients?.["sessions"] as number) ?? 0),
    },
  };
}

export async function loadLocks(supabase: Client): Promise<CoebisLock[]> {
  const { data, error } = await supabase
    .from("coebis_locks")
    .select("*")
    .order("locked_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(rowToLock);
}

/** Split the training matrix at the lock time: seen before, unseen after. */
export function splitAtLock(
  points: CoebisTrainingPoint[],
  lockedAt: string,
): { before: CoebisTrainingPoint[]; after: CoebisTrainingPoint[] } {
  const t = new Date(lockedAt).getTime();
  const before: CoebisTrainingPoint[] = [];
  const after: CoebisTrainingPoint[] = [];
  for (const p of points) {
    const at = p.recordedAt ? new Date(p.recordedAt).getTime() : NaN;
    if (Number.isFinite(at) && at > t) after.push(p);
    else before.push(p);
  }
  return { before, after };
}
