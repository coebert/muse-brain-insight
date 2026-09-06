/**
 * Force a refit of every lineage in the training pool, ignoring the
 * "unchanged since last refit" shortcut, and report each lineage's held-out
 * error before and after. Read-only: nothing is written or promoted here.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadTrainingMatrix } from "@/lib/eeg/coebis-training.server";
import { planRefit, refitLineage, selectValidatedPoints } from "@/lib/eeg/coebis-refit";
import { modelFromRow } from "@/lib/eeg/coebis-refit.server";

const session = JSON.parse(
  readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`, "utf8"),
) as { access_token: string };
const url = process.env["VITE_SUPABASE_URL"]!;
const anon = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"]!;
const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
const userId = (await sb.auth.getUser(session.access_token)).data.user!.id;
const admin = createClient(url, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const matrix = await loadTrainingMatrix(admin as never, 200000, userId, 100000);
const validated = selectValidatedPoints(matrix.points);
const { data: versionRows } = await admin
  .from("coebis_model_versions")
  .select("lineage_key, version, data_digest, model_family, coefficients, is_active, created_at")
  .eq("user_id", userId)
  .order("version", { ascending: false });
const incumbents = new Map<string, ReturnType<typeof modelFromRow>>();
for (const row of (versionRows ?? []) as unknown as Record<string, unknown>[]) {
  const key = String(row["lineage_key"]);
  if (row["is_active"] && !incumbents.has(key)) incumbents.set(key, modelFromRow(row));
}

const plan = planRefit(validated.used, {}, 99);
const out = [];
for (const entry of plan.entries) {
  const t = Date.now();
  console.info(`[full-refit] ${entry.lineageKey}: ${entry.points.length} points…`);
  const r = refitLineage(entry.lineageKey, entry.points, incumbents.get(entry.lineageKey) ?? null);
  console.info(`[full-refit] ${entry.lineageKey} done in ${Date.now() - t}ms: ${r.before.mae} -> ${r.after?.mae ?? "n/a"}`);
  out.push({
    lineage: entry.lineageKey,
    n: r.n,
    cases: r.cases,
    folds: r.folds,
    beforeMae: r.before.mae,
    afterMae: r.after?.mae ?? null,
    beforeWithin5: r.before.within5 ?? null,
    afterWithin5: r.after?.within5 ?? null,
    maeGain: r.maeGain,
    promote: r.promote,
    reason: r.reason,
  });
}
console.log(JSON.stringify({ pool: matrix.points.length, validated: validated.used.length, out }, null, 2));
