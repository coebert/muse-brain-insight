import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  describeHarmonization,
  harmonizeEpochs,
  inferReference,
} from "@/lib/eeg/harmonization";
import { summarisePhysionet, type PhysionetEpoch } from "@/lib/eeg/physionet";
import { getPhysionetPool, importPhysionet } from "@/lib/eeg/physionet.functions";
import {
  DEFAULT_SAMPLE_RATE,
  SEDATION_ICU_MONTAGE,
  epochsFromRecording,
  parseSedationIcuCsv,
  sedationIcuLineage,
  toSedationIcuRows,
  type SedationIcuDataset,
} from "@/lib/eeg/sedation-icu";

function caseRefFromName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

const DATASETS: {
  id: SedationIcuDataset;
  label: string;
  button: string;
}[] = [
  { id: "dose1", label: "DOSE-I procedural sedation", button: "Import DOSE-I recordings" },
  { id: "icare", label: "I-CARE post-arrest ICU", button: "Import I-CARE recordings" },
];

/**
 * Ingest for the two open real-patient collections closest to this app's own
 * settings: DOSE-I procedural sedation and I-CARE post-cardiac-arrest ICU EEG.
 * Both are parsed as sample CSVs, given DSA features and a burst-suppression
 * verdict by the bedside detector, harmonised onto the app's frontal bipolar
 * reference, and stored under their own lineage so the external validation
 * pipeline scores them separately and never pools them.
 */
export function SedationIcuImportPanel() {
  const [busy, setBusy] = useState<SedationIcuDataset | null>(null);
  const inputs = {
    dose1: useRef<HTMLInputElement>(null),
    icare: useRef<HTMLInputElement>(null),
  };

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
      dataset: SedationIcuDataset;
      files: File[];
    }) => {
      const epochs: PhysionetEpoch[] = [];
      const transforms = new Set<string>();
      let labelled = 0;

      for (const file of files) {
        const caseRef = caseRefFromName(file.name);
        const recording = parseSedationIcuCsv(
          await file.text(),
          DEFAULT_SAMPLE_RATE[dataset],
        );
        recording.channels.forEach((channel, i) => {
          const derived = epochsFromRecording(recording, i, { dataset, caseRef, channel });
          if (!derived.length) return;
          labelled += derived.filter((e) => e.labelSource === "dataset").length;
          const inferred = inferReference(channel);
          const harmonized = harmonizeEpochs(derived, {
            ...SEDATION_ICU_MONTAGE[dataset],
            channel,
            sampleRateHz: recording.sampleRate,
            ...(inferred !== "unknown" ? { reference: inferred } : {}),
          });
          if (harmonized[0]) transforms.add(describeHarmonization(harmonized[0].harmonization));
          epochs.push(...harmonized);
        });
      }

      if (!epochs.length) throw new Error("No usable epochs in the selected files.");
      const result = await runImport({
        data: { epochs: toSedationIcuRows(dataset, epochs) },
      });
      return {
        result,
        summary: summarisePhysionet(epochs),
        transforms: [...transforms],
        labelled,
      };
    },
    onSuccess: ({ result, summary, transforms, labelled }) => {
      toast.success(
        `Imported ${result.inserted} epochs from ${result.cases} case(s)` +
          (result.skipped ? ` — ${result.skipped} already stored` : "") +
          ` · ${summary.suppressedEpochs} suppressed`,
        {
          description:
            (labelled
              ? `${labelled} epochs carry published labels. `
              : "No published labels in these files — verdicts are this app's own. ") +
            (transforms.length ? `Harmonised: ${transforms.join(" | ")}` : ""),
        },
      );
      void pool.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setBusy(null),
  });

  const pick = (dataset: SedationIcuDataset, files: FileList | null) => {
    if (!files?.length) return;
    setBusy(dataset);
    importMutation.mutate({ dataset, files: Array.from(files) });
  };

  const lineages = new Set(DATASETS.map((d) => sedationIcuLineage(d.id).lineage));
  const stored = (pool.data?.byLineage ?? []).filter((g) => lineages.has(g.lineage));

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">Sedation and ICU collections</h3>
      </header>
      <p className="mb-4 text-xs text-muted-foreground">
        Import <span className="font-medium">DOSE-I</span> procedural-sedation recordings
        (two fronto-temporal channels at {DEFAULT_SAMPLE_RATE.dose1} Hz) or{" "}
        <span className="font-medium">I-CARE</span> post-cardiac-arrest ICU EEG
        (clinical montage, {DEFAULT_SAMPLE_RATE.icare} Hz), as sample CSVs with one
        column per channel and an optional <code>label</code> column. Features and
        burst-suppression verdicts are derived with the bedside detector; published
        labels are kept verbatim and are the only ones external validation treats as
        ground truth. Each row is harmonised onto the frontal bipolar reference and
        scored under its own lineage, never pooled.
      </p>

      <div className="flex flex-wrap gap-2">
        {DATASETS.map((d) => (
          <div key={d.id}>
            <input
              ref={inputs[d.id]}
              type="file"
              accept=".csv,.txt,text/csv"
              multiple
              className="hidden"
              onChange={(e) => {
                pick(d.id, e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="min-h-11"
              disabled={importMutation.isPending}
              onClick={() => inputs[d.id].current?.click()}
            >
              {busy === d.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {d.button}
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {stored.length ? (
          stored.map((g) => (
            <div key={g.lineage} className="rounded-md border border-border/60 p-3 text-xs">
              <p className="font-medium">{g.lineage}</p>
              <p className="text-muted-foreground">
                {g.epochs.toLocaleString()} epochs · {g.cases} case(s) ·{" "}
                {g.suppressedEpochs.toLocaleString()} suppressed
              </p>
              {g.harmonizationVersions.length > 0 && (
                <p className="text-muted-foreground">
                  Harmonisation: {g.harmonizationVersions.join(", ")}
                </p>
              )}
              {g.labels.length > 0 && (
                <p className="mt-1 text-muted-foreground">
                  {g.labels.map((l) => `${l.label}: ${l.count}`).join(" · ")}
                </p>
              )}
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            No sedation or ICU epochs stored yet.
          </p>
        )}
      </div>
    </section>
  );
}
