/**
 * One-off operator script: file the Cambridge propofol sedation blocks
 * (Chennu et al. 2016) through the app's own Chennu intake.
 *
 * The published collection ships EEGLAB .set/.fdt pairs of 91-channel EGI
 * recordings. A converter writes one CSV per volunteer per drug level holding
 * the two frontal channels (Fp1/Fp2) — the closest thing in that montage to the
 * headband the app runs on — plus a manifest carrying the block's drug level,
 * measured plasma propofol and the behavioural verdict derived from the task
 * hit count. Everything after that is the same code path the import panel uses,
 * so nothing here files rows the UI could not.
 *
 * Usage: bun scripts/run-chennu-intake.ts <manifest.json> <user_id> [startIndex] [count]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import {
  CHENNU_MONTAGE,
  chennuLabel,
  parseChennuBlock,
  toChennuRows,
  type ChennuLevel,
  type ChennuResponse,
} from "../src/lib/eeg/chennu";
import { harmonizeEpochs } from "../src/lib/eeg/harmonization";
import { importPhysionetEpochs } from "../src/lib/eeg/physionet.server";
import type { PhysionetImportRow } from "../src/lib/eeg/physionet";

interface Block {
  file: string;
  caseRef: string;
  level: ChennuLevel;
  response: ChennuResponse;
  plasmaUgMl: number | null;
  hits40: number;
  seconds: number;
}

const manifestPath = process.argv[2];
const userId = process.argv[3];
if (!manifestPath || !userId) throw new Error("usage: <manifest.json> <user_id> [start] [count]");
const start = Number(process.argv[4] ?? 0);
const count = Number(process.argv[5] ?? 1000);

const blocks = (JSON.parse(readFileSync(manifestPath, "utf8")) as Block[]).slice(
  start,
  start + count,
);

const url = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"]!;
const admin = createClient(url, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let inserted = 0;
let skipped = 0;
const labels = new Map<string, number>();

for (const block of blocks) {
  const meta = {
    caseRef: block.caseRef,
    level: block.level,
    response: block.response,
    plasmaUgMl: block.plasmaUgMl,
  };
  const text = readFileSync(block.file, "utf8");
  const epochs = parseChennuBlock(text, "raw", meta);
  const harmonized = harmonizeEpochs(epochs, {
    ...CHENNU_MONTAGE,
    channel: epochs[0]?.channel ?? CHENNU_MONTAGE.channel,
  });
  const rows: PhysionetImportRow[] = toChennuRows(harmonized, meta).map((r) => ({
    ...r,
    covariates: { ...r.covariates, task_hits_of_40: block.hits40 },
  }));

  const result = await importPhysionetEpochs(admin as never, userId, rows);
  inserted += result.inserted;
  skipped += result.skipped;
  const label = chennuLabel(block.level, block.response);
  labels.set(label, (labels.get(label) ?? 0) + result.inserted);
  console.log(
    `${block.caseRef} ${block.level} (${block.response}, ${block.hits40}/40) — ` +
      `${result.inserted} epochs stored, ${result.skipped} already there [${label}]`,
  );
}

console.log(
  JSON.stringify(
    { blocks: blocks.length, inserted, skipped, labels: Object.fromEntries(labels) },
    null,
    2,
  ),
);
