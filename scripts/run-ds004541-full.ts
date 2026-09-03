/**
 * One-off operator script: finish the ds004541 intake (all anaesthesia
 * recordings) and refit COEBIS on the resulting lineage. Local only.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { runDatasetIntake } from "@/lib/eeg/dataset-intake.server";
import { runRefitForUser } from "@/lib/eeg/coebis-refit.server";

const session = JSON.parse(
  readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`, "utf8"),
) as { user_id?: string; user?: { id: string } };
const userId = process.env["INTAKE_USER_ID"] ?? session.user_id ?? session.user?.id;
if (!userId) throw new Error("no user id");

const admin = createClient(
  process.env["VITE_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const maxFiles = Number(process.argv[2] ?? 12);
const result = await runDatasetIntake(admin as never, userId, {
  sourceIds: ["openneuro-ds004541"],
  maxFilesPerSource: maxFiles,
});
for (const s of result.sources) {
  console.log(
    `${s.sourceId}: ${s.ingested}/${s.attempted} files, ${s.epochsInserted} epochs, paired ${s.pairedInserted ?? 0}`,
  );
  for (const f of s.files) console.log(`  [${f.status}] ${f.file} — ${f.detail}`);
}

if (process.argv.includes("--refit")) {
  const refit = await runRefitForUser(admin as never, userId, "ds004541-full-intake");
  console.log(JSON.stringify(refit, null, 2));
}
