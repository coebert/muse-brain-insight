/**
 * One-off: read COEBIS-2 on the stored Cambridge propofol epochs.
 * Usage: bun scripts/run-coebis-chennu.ts <user_id>
 */
import { createClient } from "@supabase/supabase-js";

import { runChennuCoebis } from "../src/lib/eeg/coebis-chennu.server";

const userId = process.argv[2];
if (!userId) throw new Error("user id required");

const admin = createClient(
  process.env["SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { persistSession: false } },
) as never;

const report = await runChennuCoebis(admin, userId);
console.log(
  JSON.stringify(
    {
      epochsScored: report.epochsScored,
      cases: report.cases,
      unusable: report.unusable,
      applicability: report.applicability,
      byLabel: report.byLabel,
      separation: report.separation,
      truncated: report.truncated,
    },
    null,
    2,
  ),
);
