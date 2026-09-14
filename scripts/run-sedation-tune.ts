/**
 * One-off: tune the COEBIS scale to the Chennu + DOSE-I sedation labels.
 * Usage: bun scripts/run-sedation-tune.ts <user_id>
 */
import { createClient } from "@supabase/supabase-js";

import { runSedationTune } from "../src/lib/eeg/coebis-sedation-bands.server";

const userId = process.argv[2];
if (!userId) throw new Error("user id required");

const admin = createClient(
  process.env["SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { persistSession: false } },
) as never;

const r = await runSedationTune(admin, userId, admin);
console.log(
  JSON.stringify(
    {
      epochs: r.epochs,
      cases: r.cases,
      folds: r.folds,
      outputs: r.tune.outputs.map((v) => Number(v.toFixed(2))),
      inBandBefore: r.inBandBefore,
      inBandAfter: r.inBandAfter,
      heldOut: r.heldOut,
      bis: r.bis,
      promoted: r.promoted,
      reason: r.reason,
    },
    null,
    2,
  ),
);
