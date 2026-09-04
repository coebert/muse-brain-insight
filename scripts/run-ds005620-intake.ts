/**
 * One-off operator script: run the ds004541 intake with whole-file decoding,
 * then refit COEBIS. Runs under a real user session, so RLS applies exactly as
 * it does for the app.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { runDatasetIntake } from "@/lib/eeg/dataset-intake.server";
import { runRefitForUser } from "@/lib/eeg/coebis-refit.server";

const session = JSON.parse(
  readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`, "utf8"),
) as { access_token: string; refresh_token: string; user?: { id: string } };

const url = process.env["VITE_SUPABASE_URL"]!;
const key = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_ANON_KEY"]!;
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${session.access_token}` } },
});

const { data: userData } = await supabase.auth.getUser(session.access_token);
const userId = userData.user?.id ?? session.user?.id;
if (!userId) throw new Error("no user id in session");

const maxFiles = Number(process.argv[2] ?? 2);
const result = await runDatasetIntake(supabase, userId, {
  sourceIds: ["openneuro-ds005620"],
  maxFilesPerSource: maxFiles,
});
for (const s of result.sources) {
  console.log(`${s.sourceId}: ${s.ingested}/${s.attempted} files, ${s.epochsInserted} epochs, paired ${s.pairedInserted ?? 0}`);
  for (const f of s.files) console.log(`  [${f.status}] ${f.file} — ${f.detail}`);
}

if (process.argv.includes("--refit")) {
  // The refit pipeline writes its audit tables with the privileged client, as
  // the scheduled job does; it is still scoped to this one user id.
  const admin = createClient(url, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const refit = await runRefitForUser(admin as never, userId, "openneuro-ds005620-intake");
  console.log(JSON.stringify(refit, null, 2));
}
