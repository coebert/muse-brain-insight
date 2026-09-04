import { readFileSync, writeFileSync } from "fs";

const r = JSON.parse(readFileSync("/tmp/browser/vitaldb-intake/refit.json", "utf8"));
const U = "f88e34d4-b88c-4cd8-99da-34c39582ff79";
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const j = (v: unknown) => `${q(JSON.stringify(v))}::jsonb`;

const stmts: string[] = [];
stmts.push(
  `INSERT INTO coebis_refit_runs (user_id, trigger, status, started_at, finished_at, validated_points, rejected, lineages_considered, lineages_refitted, models_promoted, summary, detail)\n` +
    `VALUES (${q(U)}, 'manual', 'completed', now(), now(), ${r.validatedPoints}, ${j(r.rejected)}, ${r.considered}, ${r.results.length}, ${r.results.filter((x: { promoted: boolean }) => x.promoted).length}, ${q(r.summary)}, ${j(
      r.results.map((x: Record<string, unknown>) => ({
        lineageKey: x["lineageKey"],
        version: x["version"],
        n: x["n"],
        cases: x["cases"],
        promoted: x["promoted"],
        reason: x["reason"],
        maeGain: x["maeGain"],
        before: x["before"],
        after: x["after"],
        beforeSource: x["beforeSource"],
        folds: x["folds"],
      })),
    )})`,
);
for (const res of r.results as { row: Record<string, unknown> | null; lineageKey: string }[]) {
  if (!res.row) continue;
  const row = res.row;
  stmts.push(
    `INSERT INTO coebis_model_versions (user_id, run_id, lineage_key, version, model_family, coefficients, training, metrics_before, metrics_after, mae_gain, promoted, is_active, reason, data_digest)\n` +
      `VALUES (${q(U)}, (SELECT id FROM coebis_refit_runs WHERE user_id=${q(U)} ORDER BY started_at DESC LIMIT 1), ${q(res.lineageKey)}, ${row["version"]}, ${q(String(row["model_family"]))}, ${j(row["coefficients"])}, ${j(row["training"])}, ${j(row["metrics_before"])}, ${j(row["metrics_after"])}, ${row["mae_gain"]}, ${row["promoted"]}, ${row["is_active"]}, ${q(String(row["reason"]))}, ${q(String(row["data_digest"]))})`,
  );
}
writeFileSync("/tmp/browser/vitaldb-intake/refit.sql", stmts.join(";\n") + ";\n");
console.log("sql written:", stmts.length, "statements");
