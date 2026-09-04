/**
 * Run the COEBIS calibration pipeline once for the signed-in user, over every
 * lineage, and persist the run (including per-lineage before/after metrics for
 * candidates that did not clear the gate) so the dashboard can show it.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { runRefitForUser } from "@/lib/eeg/coebis-refit.server";

const session = JSON.parse(
  readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`, "utf8"),
) as { access_token: string };
const url = process.env["VITE_SUPABASE_URL"]!;
const anon =
  process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_ANON_KEY"]!;
const sb = createClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${session.access_token}` } },
});
const userId = (await sb.auth.getUser(session.access_token)).data.user!.id;
const admin = createClient(url, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const report = await runRefitForUser(admin as never, userId, "manual");
console.log(
  JSON.stringify(
    {
      status: report.status,
      summary: report.summary,
      validatedPoints: report.validatedPoints,
      lineagesRefitted: report.lineagesRefitted,
      modelsPromoted: report.modelsPromoted,
      detail: report.detail.map((d) => ({
        lineage: d.lineageKey,
        n: d.n,
        cases: d.cases,
        promoted: d.promoted,
        maeGain: d.maeGain,
        beforeMae: d.before.mae,
        afterMae: d.after.mae,
        reason: d.reason,
      })),
      error: report.error ?? null,
    },
    null,
    2,
  ),
);
