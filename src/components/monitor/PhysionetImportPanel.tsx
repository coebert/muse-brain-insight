import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Brain, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  deriveEpochsFromRaw,
  parsePhysionetPowerCsv,
  parsePhysionetRawCsv,
  summarisePhysionet,
  toImportRows,
  type PhysionetEpoch,
  type PhysionetImportRow,
} from "@/lib/eeg/physionet";
import { getPhysionetPool, importPhysionet } from "@/lib/eeg/physionet.functions";

/** Case reference from an export filename, e.g. "case_07_eeg.csv" → "case_07_eeg". */
function caseRefFromName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/**
 * PhysioNet ingest for the two open anaesthesia collections. Raw GABA-anaesthesia
 * recordings get DSA features and burst-suppression labels derived with the
 * bedside detector; published power spectra are mapped onto the DSA grid with
 * their labels kept verbatim. Both keep their own lineage and stay outside
 * device-specific alignment.
 */
export function PhysionetImportPanel() {
  const [busy, setBusy] = useState<"gaba" | "power" | null>(null);
  const gabaRef = useRef<HTMLInputElement>(null);
  const powerRef = useRef<HTMLInputElement>(null);

  const runImport = useServerFn(importPhysionet);
  const runPool = useServerFn(getPhysionetPool);

  const pool = useQuery({
    queryKey: ["physionet-pool"],
    queryFn: () => runPool({}),
  });

  const importMutation = useMutation({
    mutationFn: async ({
      dataset,
      files,
    }: {
      dataset: "gaba" | "power";
      files: File[];
    }) => {
      const epochs: PhysionetEpoch[] = [];
      for (const file of files) {
        const caseRef = caseRefFromName(file.name);
        const text = await file.text();
        if (dataset === "gaba") {
          const rec = parsePhysionetRawCsv(text);
          rec.signals.forEach((signal, i) => {
            epochs.push(
              ...deriveEpochsFromRaw(signal, rec.sampleRate, {
                caseRef,
                channel: rec.channels[i] ?? null,
              }),
            );
          });
        } else {
          epochs.push(...parsePhysionetPowerCsv(text, { caseRef }));
        }
      }
      if (!epochs.length) throw new Error("No usable epochs in the selected files.");
      const rows: PhysionetImportRow[] = toImportRows(dataset, epochs);
      const result = await runImport({ data: { epochs: rows } });
      return { result, summary: summarisePhysionet(epochs) };
    },
    onSuccess: ({ result, summary }) => {
      toast.success(
        `Imported ${result.inserted} epochs from ${result.cases} case(s)` +
          (result.skipped ? ` — ${result.skipped} already stored` : "") +
          ` · ${summary.suppressedEpochs} suppressed`,
      );
      void pool.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setBusy(null),
  });

  const pick = (dataset: "gaba" | "power", files: FileList | null) => {
    if (!files?.length) return;
    setBusy(dataset);
    importMutation.mutate({ dataset, files: Array.from(files) });
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-center gap-2">
        <Brain className="h-4 w-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">PhysioNet anaesthesia collections</h3>
      </header>
      <p className="mb-4 text-xs text-muted-foreground">
        Import <span className="font-medium">eeg-gaba-anesthesia</span> raw recordings
        (CSV of samples — features and burst-suppression labels are derived here) or{" "}
        <span className="font-medium">eeg-power-anesthesia</span> spectral exports (CSV
        with a frequency-axis header — published labels are kept). Each row is stored
        with its own source lineage and is used for population priors only.
      </p>

      <div className="flex flex-wrap gap-2">
        <input
          ref={gabaRef}
          type="file"
          accept=".csv,.txt,text/csv"
          multiple
          className="hidden"
          onChange={(e) => {
            pick("gaba", e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={powerRef}
          type="file"
          accept=".csv,.txt,text/csv"
          multiple
          className="hidden"
          onChange={(e) => {
            pick("power", e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={importMutation.isPending}
          onClick={() => gabaRef.current?.click()}
        >
          {busy === "gaba" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Import raw GABA recordings
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={importMutation.isPending}
          onClick={() => powerRef.current?.click()}
        >
          {busy === "power" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Import power spectra
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        {pool.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading external pool…</p>
        ) : pool.data && pool.data.byLineage.length ? (
          pool.data.byLineage.map((g) => (
            <div key={g.lineage} className="rounded-md border border-border/60 p-3 text-xs">
              <p className="font-medium">{g.lineage}</p>
              <p className="text-muted-foreground">
                {g.epochs.toLocaleString()} epochs · {g.cases} case(s) ·{" "}
                {g.suppressedEpochs.toLocaleString()} suppressed
              </p>
              {g.labels.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  {g.labels.map((l) => `${l.label}: ${l.count}`).join(" · ")}
                </p>
              )}
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            No external spectral epochs stored yet.
          </p>
        )}
      </div>
    </section>
  );
}
