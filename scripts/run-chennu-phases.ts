/**
 * One-off: COEBIS across the Cambridge propofol arc, phase by phase.
 * Usage: bun scripts/run-chennu-phases.ts <user_id>
 */
import { createClient } from "@supabase/supabase-js";

import { runChennuPhaseFit } from "../src/lib/eeg/coebis-chennu-phases.server";

const userId = process.argv[2];
if (!userId) throw new Error("user id required");

const admin = createClient(
  process.env["SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { persistSession: false } },
) as never;

const r = await runChennuPhaseFit(admin, userId);
console.log(
  JSON.stringify(
    {
      epochs: r.epochs,
      cases: r.cases,
      byPhase: r.byPhase,
      deepenedCount: r.deepenedCount,
      recoveredCount: r.recoveredCount,
      comparableCount: r.comparableCount,
      arcs: r.arcs.slice(0, 8),
      truncated: r.truncated,
    },
    null,
    2,
  ),
);
