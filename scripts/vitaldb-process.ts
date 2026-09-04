/**
 * Replay downloaded VitalDB cases through the app estimator and emit paired
 * readings as CSV rows ready for COPY into bis_paired_points.
 * Usage: bun scripts/vitaldb-process.ts <caseid...>
 */
import { readFileSync, readdirSync, appendFileSync } from "fs";

import {
  assembleVitalDbNumerics,
  assembleVitalDbWaveform,
  pairVitalDbCase,
  type VitalDbTrackFile,
} from "../src/lib/eeg/vitaldb-waveform";
import { parseVitalDbClinicalCsv } from "../src/lib/eeg/vitaldb";
import { validatePairedCases } from "../src/lib/eeg/vitaldb-validation";

const USER_ID = "f88e34d4-b88c-4cd8-99da-34c39582ff79";
const OUT = "/tmp/browser/vitaldb-intake/rows.csv";

const clinical = parseVitalDbClinicalCsv(
  readFileSync("/tmp/browser/vitaldb-intake/cases.csv", "utf8"),
);

const csvCell = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const ids = process.argv.slice(2);
if (!ids.length) throw new Error("Pass case ids.");

for (const id of ids) {
  const dir = `/tmp/browser/vitaldb-intake/cases/${id}`;
  const info = clinical.get(id);
  if (!info) {
    console.log(`case ${id}: not in clinical table, skipped`);
    continue;
  }
  let files: VitalDbTrackFile[];
  try {
    files = readdirSync(dir).map((f) => ({
      name: f.replace(/\.csv$/, "").replaceAll("__", "/"),
      text: readFileSync(`${dir}/${f}`, "utf8"),
    }));
  } catch {
    console.log(`case ${id}: no downloads, skipped`);
    continue;
  }
  try {
    const wave = assembleVitalDbWaveform(files);
    const numerics = assembleVitalDbNumerics(files);
    const paired = pairVitalDbCase(info, wave, numerics, {
      strideSeconds: 10,
      minSqi: 50,
      toleranceSeconds: 2,
    });
    const validation = validatePairedCases([paired]);
    const verdict = validation.cases[0];
    if (!validation.acceptedCaseRefs.includes(paired.caseRef)) {
      console.log(
        `case ${id}: rejected — ${verdict?.reasons.join(" ") ?? validation.summary}`,
      );
      continue;
    }
    const now = new Date().toISOString();
    const rows = paired.points.map((p) =>
      [
        USER_ID, // user_id
        null, // session_id
        now, // recorded_at
        p.atSeconds,
        p.bis,
        p.bisSef,
        p.bisSr,
        p.appIndex,
        p.appSef,
        p.appSr,
        p.reliable,
        p.sqi,
        p.lagSeconds,
        "general",
        "vitaldb-snuadc",
        "vitaldb",
        "vitaldb",
        paired.lineageKey,
        "replay",
        JSON.stringify(p.ce),
        JSON.stringify({
          imported: true,
          replayed: true,
          caseRef: paired.caseRef,
          ageBand: paired.covariates.ageBand,
          sex: paired.covariates.sex,
          regimen: paired.covariates.regimen,
          frailty: paired.covariates.frailty,
        }),
        p.externalRef,
      ]
        .map(csvCell)
        .join(","),
    );
    appendFileSync(OUT, rows.join("\n") + "\n");
    console.log(
      `case ${id}: ${paired.points.length} pairs kept (${verdict?.verdict}), span ${verdict?.spanSeconds}s`,
    );
  } catch (err) {
    console.log(`case ${id}: failed — ${err instanceof Error ? err.message : err}`);
  }
}
