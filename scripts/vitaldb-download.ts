/**
 * Emit a curl download list for the VitalDB tracks of the requested cases.
 * Usage: bun scripts/vitaldb-download.ts <caseid...>
 * Writes /tmp/browser/vitaldb-intake/downloads.txt with "url outfile" lines.
 */
import { readFileSync, mkdirSync } from "fs";

const WANTED = [
  "BIS/EEG1_WAV",
  "BIS/EEG2_WAV",
  "SNUADC/EEG1_WAV",
  "SNUADC/EEG2_WAV",
  "BIS/BIS",
  "BIS/SEF",
  "BIS/SR",
  "BIS/EMG",
  "BIS/SQI",
  "Orchestra/PPF20_CE",
  "Orchestra/RFTN20_CE",
  "Orchestra/KET20_CE",
];

const ids = process.argv.slice(2);
if (!ids.length) throw new Error("Pass case ids.");

const trks = readFileSync("/tmp/browser/vitaldb-intake/trks.csv", "utf8").split("\n");
const wanted = new Set(ids);
const lines: string[] = [];
const found = new Map<string, number>();
for (const line of trks.slice(1)) {
  const [caseid, tname, tid] = line.split(",");
  if (!caseid || !tname || !tid || !wanted.has(caseid)) continue;
  const name = tname.trim();
  if (!WANTED.includes(name)) continue;
  mkdirSync(`/tmp/browser/vitaldb-intake/cases/${caseid}`, { recursive: true });
  const file = `/tmp/browser/vitaldb-intake/cases/${caseid}/${name.replaceAll("/", "__")}.csv`;
  lines.push(`${tid.trim()} ${file}`);
  found.set(caseid, (found.get(caseid) ?? 0) + 1);
}
const { writeFileSync } = await import("fs");
writeFileSync("/tmp/browser/vitaldb-intake/downloads.txt", lines.join("\n"));
for (const id of ids) console.log(`case ${id}: ${found.get(id) ?? 0} tracks`);
