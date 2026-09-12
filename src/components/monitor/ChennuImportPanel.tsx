import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Users } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CHENNU_LEVELS,
  CHENNU_MONTAGE,
  chennuCaseRef,
  chennuLabel,
  chennuLevelFromName,
  parseChennuBlock,
  toChennuRows,
  type ChennuFormat,
  type ChennuLevel,
  type ChennuResponse,
} from "@/lib/eeg/chennu";
import { describeHarmonization, harmonizeEpochs } from "@/lib/eeg/harmonization";
import { summarisePhysionet, type PhysionetImportRow } from "@/lib/eeg/physionet";
import { importPhysionet } from "@/lib/eeg/physionet.functions";
import { cn } from "@/lib/utils";

const RESPONSES: { key: ChennuResponse; label: string }[] = [
  { key: "responsive", label: "Still answered" },
  { key: "unresponsive", label: "Did not answer" },
  { key: "unknown", label: "Not recorded" },
];

/**
 * Cambridge propofol sedation ingest.
 *
 * Each file is one volunteer at one drug level, so the level and the
 * behavioural verdict for that block are chosen here and stamped on every
 * epoch in it. That verdict — a person answering or not — is what the depth
 * index gets graded against on the Calibration tab.
 */
export function ChennuImportPanel() {
  const [format, setFormat] = useState<ChennuFormat>("raw");
  const [level, setLevel] = useState<ChennuLevel>("moderate");
  const [response, setResponse] = useState<ChennuResponse>("unresponsive");
  const [plasma, setPlasma] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const runImport = useServerFn(importPhysionet);

  const importMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const rows: PhysionetImportRow[] = [];
      const transforms = new Set<string>();
      const labels = new Set<string>();

      for (const file of files) {
        const meta = {
          caseRef: chennuCaseRef(file.name),
          // The filename wins when it names a level, so a mixed selection is
          // not silently filed under one setting.
          level: chennuLevelFromName(file.name) ?? level,
          response,
          plasmaUgMl: plasma.trim() === "" ? null : Number(plasma),
        };
        if (meta.plasmaUgMl != null && !Number.isFinite(meta.plasmaUgMl)) {
          throw new Error("The plasma propofol figure is not a number.");
        }
        const epochs = parseChennuBlock(await file.text(), format, meta);
        const harmonized = harmonizeEpochs(epochs, {
          ...CHENNU_MONTAGE,
          channel: epochs[0]?.channel ?? CHENNU_MONTAGE.channel,
        });
        if (harmonized[0]) transforms.add(describeHarmonization(harmonized[0].harmonization));
        labels.add(chennuLabel(meta.level, meta.response));
        rows.push(...toChennuRows(harmonized, meta));
      }

      if (!rows.length) throw new Error("No usable epochs in the selected files.");
      const result = await runImport({ data: { epochs: rows } });
      return {
        result,
        summary: summarisePhysionet(rows),
        transforms: [...transforms],
        labels: [...labels],
      };
    },
    onSuccess: ({ result, summary, transforms, labels }) => {
      toast.success(
        `Imported ${result.inserted} epochs from ${result.cases} volunteer block(s)` +
          (result.skipped ? ` — ${result.skipped} already stored` : ""),
        {
          description: `Labelled ${labels.join(", ")} · ${summary.epochs} epochs${
            transforms.length ? ` · harmonised: ${transforms.join(" | ")}` : ""
          }`,
        },
      );
      if (fileRef.current) fileRef.current.value = "";
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setBusy(false),
  });

  const pick = (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    importMutation.mutate(Array.from(files));
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-center gap-2">
        <Users className="h-4 w-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">Cambridge propofol sedation (Chennu)</h3>
      </header>
      <p className="mb-4 text-xs text-muted-foreground">
        Volunteers were recorded awake, mildly and moderately sedated, and again in recovery,
        with a task showing whether they still answered at each level. Import one file per
        volunteer per level and set what happened in that block: someone sedated who still
        answered is stored as responsive, not as awake. The recordings are high-density scalp
        EEG, so they stay in their own collection and never enter headband alignment.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">File contents</Label>
          <div className="flex gap-2">
            {(["raw", "power"] as ChennuFormat[]).map((f) => (
              <Button
                key={f}
                type="button"
                size="sm"
                variant={format === f ? "default" : "outline"}
                onClick={() => setFormat(f)}
              >
                {f === "raw" ? "Signal samples" : "Power spectra"}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs" htmlFor="chennu-plasma">
            Plasma propofol, µg/ml (optional)
          </Label>
          <Input
            id="chennu-plasma"
            inputMode="decimal"
            value={plasma}
            onChange={(e) => setPlasma(e.target.value)}
            placeholder="e.g. 1.3"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Level for files that do not name one</Label>
          <div className="flex flex-wrap gap-2">
            {CHENNU_LEVELS.map((l) => (
              <Button
                key={l.key}
                type="button"
                size="sm"
                variant={level === l.key ? "default" : "outline"}
                onClick={() => setLevel(l.key)}
              >
                {l.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Did the volunteer answer in this block?</Label>
          <div className="flex flex-wrap gap-2">
            {RESPONSES.map((r) => (
              <Button
                key={r.key}
                type="button"
                size="sm"
                variant={response === r.key ? "default" : "outline"}
                onClick={() => setResponse(r.key)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <p className={cn("mt-3 text-xs text-muted-foreground")}>
        These files will be stored as{" "}
        <span className="font-mono">{chennuLabel(level, response)}</span>.
        {response === "unknown"
          ? " Blocks with no verdict are kept, but the responsiveness fit leaves them out."
          : ""}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv"
          multiple
          className="hidden"
          onChange={(e) => pick(e.target.files)}
        />
        <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Choose block files
        </Button>
      </div>
    </section>
  );
}
