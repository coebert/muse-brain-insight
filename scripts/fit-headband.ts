/** Fit (and optionally persist) the headband-only provisional COEBIS model. */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadTrainingMatrix } from "@/lib/eeg/coebis-training.server";
import { selectValidatedPoints } from "@/lib/eeg/coebis-refit";
import { modelFromRow } from "@/lib/eeg/coebis-refit.server";
import { refitHeadbandLineage, isHeadbandLineage } from "@/lib/eeg/headband-fit";

const persist = process.argv.includes("--persist");
const session = JSON.parse(
  readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`, "utf8"),
) as { access_token: string };
const url = process.env["VITE_SUPABASE_URL"]!;
const anon = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_ANON_KEY"]!;
const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
const userId = (await sb.auth.getUser(session.access_token)).data.user!.id;
const admin = createClient(url, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const matrix = await loadTrainingMatrix(admin as never, 200000, userId, 100000);
const validated = selectValidatedPoints(matrix.points);
const byLineage = new Map<string, typeof validated.used>();
for (const p of validated.used) {
  const key = p.lineageKey ?? "unlabelled";
  if (!isHeadbandLineage(key)) continue;
  byLineage.set(key, [...(byLineage.get(key) ?? []), p]);
}

const { data: versionRows } = await admin
  .from("coebis_model_versions")
  .select("lineage_key, version, data_digest, model_family, coefficients, is_active")
  .eq("user_id", userId)
  .order("version", { ascending: false });
const rows = (versionRows ?? []) as unknown as Record<string, unknown>[];
const maxVersion = new Map<string, number>();
const incumbents = new Map<string, ReturnType<typeof modelFromRow>>();
for (const row of rows) {
  const key = String(row["lineage_key"]);
  maxVersion.set(key, Math.max(maxVersion.get(key) ?? 0, Number(row["version"])));
  if (row["is_active"] && !incumbents.has(key)) incumbents.set(key, modelFromRow(row));
}

for (const [key, points] of byLineage) {
  const result = refitHeadbandLineage(key, points, incumbents.get(key) ?? null);
  console.log(JSON.stringify({
    lineageKey: key, n: result.n, cases: result.cases, folds: result.folds,
    provisional: result.provisional, promote: result.promote, reason: result.reason,
    gain: result.model?.gain, offset: result.model?.offset,
    maeGain: result.maeGain, before: result.before, after: result.after,
  }, null, 2));
  if (!persist || !result.model || !result.promote) continue;
  const version = (maxVersion.get(key) ?? 0) + 1;
  const { error } = await admin.from("coebis_model_versions").upsert({
    user_id: userId, lineage_key: key, version, model_family: result.family,
    coefficients: { gain: result.model.gain, offset: result.model.offset, knots: result.model.knots,
      terms: [], ceTerms: [], n: result.model.n, sessions: result.model.sessions,
      provisional: result.provisional },
    training: { n: result.n, cases: result.cases, folds: result.folds, lineageKey: key, headbandOnly: true },
    metrics_before: { ...result.before, source: result.beforeSource },
    metrics_after: result.after, mae_gain: result.maeGain,
    promoted: true, is_active: true, reason: result.reason, data_digest: result.digest,
  }, { onConflict: "user_id,lineage_key,data_digest", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  await admin.from("coebis_model_versions").update({ is_active: false })
    .eq("user_id", userId).eq("lineage_key", key).neq("version", version);
  console.log(`persisted v${version} for ${key}`);
}
