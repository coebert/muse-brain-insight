/**
 * Operator script: import VitalDB cases that publish both the bedside frontal
 * EEG waveform and the BIS numerics.
 *
 * Each case is stored twice, deliberately:
 *
 *  - the monitor numerics (BIS, SEF, SR, SQI) as external reference points,
 *    which is where the pathology dashboard reads *recorded* suppression from;
 *  - the waveform replayed through the app's own estimator as paired readings,
 *    which is where the dashboard reads the app's *own* suppression ratio from.
 *
 * Both land on the same case ref and clock, so the dashboard grades the app's
 * suppression ratio against the monitor's, not against a guessed interval.
 *
 * Usage: bun scripts/run-vitaldb-wave-intake.ts [caseCount] [caseId ...]
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { mapVitalDbCase, parseVitalDbClinicalCsv } from "@/lib/eeg/vitaldb";
import { importVitalDbCases } from "@/lib/eeg/vitaldb.server";
import {
  assembleVitalDbNumerics,
  assembleVitalDbWaveform,
  pairVitalDbCase,
  type VitalDbTrackFile,
} from "@/lib/eeg/vitaldb-waveform";
import { importVitalDbPairedCases } from "@/lib/eeg/vitaldb-waveform.server";

const API = "https://api.vitaldb.net";
const WANTED = [
  "BIS/EEG1_WAV",
  "BIS/EEG2_WAV",
  "BIS/BIS",
  "BIS/SEF",
  "BIS/SR",
  "BIS/EMG",
  "BIS/SQI",
  "Orchestra/PPF20_CE",
  "Orchestra/RFTN20_CE",
];
const REQUIRED = ["BIS/EEG1_WAV", "BIS/BIS", "BIS/SR", "BIS/SQI"];

async function cached(path: string, url: string): Promise<string> {
  if (existsSync(path)) return readFileSync(path, "utf8");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const text = await res.text();
  writeFileSync(path, text);
  return text;
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

const clinical = parseVitalDbClinicalCsv(await cached("/tmp/vitaldb-cases.csv", `${API}/cases`));
const trkText = await cached("/tmp/vitaldb-trks.csv", `${API}/trks`);

const tracks = new Map<string, Map<string, string>>();
for (const line of trkText.split(/\r?\n/).slice(1)) {
  const [caseId, tname, tid] = line.split(",");
  if (!caseId || !tname || !tid) continue;
  if (!WANTED.includes(tname)) continue;
  const m = tracks.get(caseId) ?? new Map<string, string>();
  m.set(tname, tid.trim());
  tracks.set(caseId, m);
}

const explicit = process.argv.slice(3);
const wantCount = Number(process.argv[2] ?? 3);
const eligible = [...tracks.entries()]
  .filter(([, m]) => REQUIRED.every((t) => m.has(t)))
  .map(([c]) => c)
  .sort((a, b) => Number(a) - Number(b));
const caseIds = explicit.length ? explicit : eligible.slice(0, wantCount);
console.log(`${eligible.length} eligible cases; importing ${caseIds.join(", ")}`);

for (const caseId of caseIds) {
  const info = clinical.get(caseId);
  const trk = tracks.get(caseId);
  if (!info || !trk) {
    console.log(`case ${caseId}: no clinical row or tracks — skipped`);
    continue;
  }
  const files: VitalDbTrackFile[] = [];
  for (const [name, tid] of trk) {
    files.push({ name, text: await cached(`/tmp/vitaldb-${caseId}-${tid}.csv`, `${API}/${tid}`) });
  }

  const numerics = assembleVitalDbNumerics(files);
  const wave = assembleVitalDbWaveform(files);
  console.log(
    `case ${caseId}: ${numerics.length} monitor seconds, ` +
      `${wave.channels.map((c) => c.channel).join("+")} @ ${wave.sampleRate} Hz, ` +
      `${Math.round(wave.durationSeconds)} s from ${wave.startSeconds}`,
  );

  const mapped = mapVitalDbCase(info, numerics);
  const ref = await importVitalDbCases(supabase, userId, [
    { caseRef: mapped.caseRef, covariates: mapped.covariates, points: mapped.points },
  ]);
  console.log(`  reference: +${ref.inserted} (skipped ${ref.skipped})`);

  const paired = pairVitalDbCase(info, wave, numerics);
  const withSr = paired.points.filter((p) => p.bisSr != null).length;
  if (!paired.points.length) {
    console.log(`  paired: none (${JSON.stringify(paired.rejected)})`);
    continue;
  }
  const stored = await importVitalDbPairedCases(supabase, userId, [
    {
      caseRef: paired.caseRef,
      lineageKey: paired.lineageKey,
      covariates: paired.covariates,
      points: paired.points,
    },
  ]);
  console.log(
    `  paired: +${stored.inserted} (skipped ${stored.skipped}), ` +
      `${withSr} carry a monitor SR, lineage ${paired.lineageKey}`,
  );
}
