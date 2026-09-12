/**
 * One-off: run the responsiveness state fit for a user with the service role.
 * Usage: bun scripts/run-state-fit.ts <user_id>
 */
import { createClient } from "@supabase/supabase-js";
import { loadStatePool, loadStateSummary } from "../src/lib/eeg/state-labels.server";
import { gradeStateFit } from "../src/lib/eeg/state-labels";

const userId = process.argv[2];
if (!userId) throw new Error("user id required");

const url = process.env["SUPABASE_URL"]!;
const key = process.env["SUPABASE_SERVICE_ROLE_KEY"]!;
const admin = createClient(url, key, { auth: { persistSession: false } }) as never;

const summary = await loadStateSummary(admin, userId);
console.log("pool", JSON.stringify({ ...summary, current: summary.current }, null, 2));

const { points } = await loadStatePool(admin, userId);
const report = gradeStateFit(points);
console.log(
  "fit",
  JSON.stringify(
    {
      epochs: report.epochs,
      cases: report.cases,
      responsive: report.responsive,
      unresponsive: report.unresponsive,
      before: report.before,
      after: report.after,
      folds: report.folds,
      promote: report.promote,
      reason: report.reason,
      digest: report.digest,
    },
    null,
    2,
  ),
);
