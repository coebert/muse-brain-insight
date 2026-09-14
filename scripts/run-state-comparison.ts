/**
 * One-off: grade the small state models against COEBIS on Chennu + DOSE-I.
 * Usage: bun scripts/run-state-comparison.ts <user_id>
 */
import { createClient } from "@supabase/supabase-js";

import { compareStateModels } from "../src/lib/eeg/state-comparison.server";

const userId = process.argv[2];
if (!userId) throw new Error("user id required");

const admin = createClient(
  process.env["SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { persistSession: false } },
) as never;

const r = await compareStateModels(admin, userId);
console.log(
  JSON.stringify(
    {
      epochs: r.epochs,
      cases: r.cases,
      responsive: r.responsive,
      unresponsive: r.unresponsive,
      folds: r.folds,
      coebisAuc: r.coebis.auc,
      coebisGap: r.coebis.gap,
      referenceAuc: r.reference.auc,
      fullAuc: r.full.auc,
      simple: r.simple.map((s) => ({
        key: s.key,
        terms: s.terms,
        auc: Number(s.separation.auc.toFixed(3)),
        gap: Number(s.separation.gap.toFixed(1)),
        weights: s.weights,
      })),
      byLineage: r.byLineage,
      truncated: r.truncated,
    },
    null,
    2,
  ),
);
