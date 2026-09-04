/** Fit the BIS model on every lineage and promote whatever clears the gate. */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadBisModelReport, promoteBisFits } from "@/lib/eeg/bis-model.server";

const session = JSON.parse(
  readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`, "utf8"),
) as any;
const url = process.env["VITE_SUPABASE_URL"]!;
const key = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_ANON_KEY"]!;
const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${session.access_token}` } },
});
const userId = (await sb.auth.getUser(session.access_token)).data.user!.id;
const admin = createClient(url, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const report = await loadBisModelReport(admin as never, userId);
for (const f of report.fits) {
  console.log(
    `${f.lineage}: n=${f.points} cases=${f.cases} terms=${f.terms.join("+")} before mae=${f.before?.mae.toFixed(2)} r=${f.before?.correlation.toFixed(3)} after mae=${f.after?.mae.toFixed(2)} r=${f.after?.correlation.toFixed(3)} gain=${f.maeGain?.toFixed(2)} promotable=${f.promotable} ${f.blockedBy ?? ""}`,
  );
}
if (process.env["PROMOTE"] === "1") {
  const out = await promoteBisFits(admin as never, userId, report, "bedside BIS refit");
  console.log(JSON.stringify({ promoted: out.promoted, skipped: out.skipped }, null, 2));
}
