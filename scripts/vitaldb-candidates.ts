/**
 * Pick VitalDB cases for bulk paired intake: cases that publish the frontal
 * EEG waveform plus the BIS numerics needed for pairing, excluding cases
 * already imported into bis_paired_points.
 */
import { readFileSync, writeFileSync } from "fs";

const trks = readFileSync("/tmp/browser/vitaldb-intake/trks.csv", "utf8").split("\n");
const perCase = new Map<string, Set<string>>();
for (const line of trks.slice(1)) {
  const [caseid, tname] = line.split(",");
  if (!caseid || !tname) continue;
  let set = perCase.get(caseid);
  if (!set) perCase.set(caseid, (set = new Set()));
  set.add(tname.trim());
}

const need = ["BIS/EEG1_WAV", "BIS/BIS", "BIS/SR", "BIS/SQI"];
const imported = new Set(
  readFileSync("/tmp/browser/vitaldb-intake/imported.txt", "utf8")
    .split("\n")
    .map((l) => l.trim().replace(/^vitaldb-/, ""))
    .filter(Boolean),
);

const candidates: string[] = [];
for (const [caseid, set] of perCase) {
  if (imported.has(caseid)) continue;
  if (need.every((t) => set.has(t))) candidates.push(caseid);
}
candidates.sort((a, b) => Number(a) - Number(b));
writeFileSync("/tmp/browser/vitaldb-intake/candidates.txt", candidates.join("\n"));
console.log(`candidates: ${candidates.length} (first: ${candidates.slice(0, 10).join(", ")})`);
