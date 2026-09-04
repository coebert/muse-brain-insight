/**
 * Operator script: import the figshare "EEG and BIS raw data" record (5589841,
 * CC-BY 4.0) — 24 surgical cases, each a MATLAB v7.3 file with a raw frontal
 * EEG trace and the bedside BIS index over the same recording.
 *
 * Each case is replayed through the app's own estimator and stored as paired
 * readings under its own acquisition lineage.
 *
 * Usage: bun scripts/run-figshare-bis-intake.ts [caseCount]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { pairFigshareBisCase } from "@/lib/eeg/figshare-bis";
import { importFigshareBisCases } from "@/lib/eeg/figshare-bis.server";

const ARTICLE = "https://api.figshare.com/v2/articles/5589841";
const CACHE = "/tmp/figshare-5589841";

const h5 = await import("h5wasm");
await h5.ready;

mkdirSync(CACHE, { recursive: true });

async function cached(name: string, url: string): Promise<Uint8Array> {
  const path = `${CACHE}/${name}`;
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(path, bytes);
  return bytes;
}

const session = JSON.parse(
  readFileSync(`${process.env["HOME"]}/.cache/lovable-auth/session.json`, "utf8"),
) as { access_token: string; user?: { id: string } };

const url = process.env["VITE_SUPABASE_URL"]!;
const key = process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_ANON_KEY"]!;
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${session.access_token}` } },
});
const { data: userData } = await supabase.auth.getUser(session.access_token);
const userId = userData.user?.id ?? session.user?.id;
if (!userId) throw new Error("no user id in session");

const meta = (await (await fetch(ARTICLE)).json()) as {
  license: { name: string };
  files: { name: string; download_url: string }[];
};
if (!/CC BY/i.test(meta.license.name)) throw new Error(`licence changed: ${meta.license.name}`);

const wanted = Number(process.argv[2] ?? 24);
const files = meta.files
  .filter((f) => /^case\d+\.mat$/.test(f.name))
  .sort((a, b) => Number(a.name.match(/\d+/)![0]) - Number(b.name.match(/\d+/)![0]))
  .slice(0, wanted);
console.log(`${meta.license.name}; importing ${files.length} cases`);

let totalPairs = 0;
let totalCases = 0;
for (const file of files) {
  const caseId = file.name.replace(/\.mat$/, "");
  try {
    const bytes = await cached(file.name, file.download_url);
    const FS = (h5 as unknown as { FS: { writeFile: (p: string, d: Uint8Array) => void } }).FS;
    FS.writeFile(file.name, bytes);
    const handle = new (h5 as unknown as { File: new (p: string, m: string) => any }).File(
      file.name,
      "r",
    );
    const eeg = handle.get("EEG").value as Float64Array;
    const bis = handle.get("bis").value as Float64Array;
    handle.close();

    const paired = pairFigshareBisCase(caseId, eeg, bis);
    if (!paired.points.length) {
      console.log(`${caseId}: no pairs (${JSON.stringify(paired.rejected)})`);
      continue;
    }
    const stored = await importFigshareBisCases(supabase, userId, [
      { caseRef: paired.caseRef, lineageKey: paired.lineageKey, points: paired.points },
    ]);
    totalPairs += stored.inserted;
    if (stored.inserted) totalCases++;
    console.log(
      `${caseId}: ${Math.round(paired.durationSeconds)} s @ ${paired.sampleRate} Hz, ` +
        `+${stored.inserted} pairs (skipped ${stored.skipped}), lineage ${paired.lineageKey}`,
    );
  } catch (err) {
    console.log(`${caseId}: skipped — ${(err as Error).message}`);
  }
}
console.log(`total: ${totalPairs} paired readings across ${totalCases} cases`);
