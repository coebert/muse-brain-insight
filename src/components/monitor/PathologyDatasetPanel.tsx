import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Brain, FileText, Loader2, Upload, Zap } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  describeHarmonization,
  harmonizeEpochs,
  inferReference,
} from "@/lib/eeg/harmonization";
import {
  PATHOLOGY_DATASETS,
  epochsFromPathologyRecording,
  parsePathologyAnnotations,
  pathologyDataset,
  summarisePathologyLabels,
  toPathologyRows,
  type PathologyAnnotation,
  type PathologyCategory,
  type PathologyDataset,
  type PathologyDatasetInfo,
} from "@/lib/eeg/pathology-datasets";
import { cn } from "@/lib/utils";
import type { PhysionetEpoch } from "@/lib/eeg/physionet";
import { getPhysionetPool, importPhysionet } from "@/lib/eeg/physionet.functions";
import { parseSedationIcuCsv } from "@/lib/eeg/sedation-icu";

function caseRefFromName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

interface PoolGroup {
  lineage: string;
  epochs: number;
  cases: number;
  suppressedEpochs: number;
  harmonizationVersions: string[];
  labels: { label: string; count: number }[];
}

/**
 * Ingest for the pathology collections — recorded seizures and clinically
 * reported CNS disease. These sharpen the seizure and diagnostic models; they
 * carry no depth reference, so they never enter paired COEBIS alignment. Each
 * collection keeps its own lineage, licence note and harmonisation record.
 */
export function PathologyDatasetPanel() {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-center gap-2">
        <Brain className="h-4 w-4 text-primary" aria-hidden />
        <h3 className="text-sm font-semibold">Pathology collections</h3>
      </header>
      <p className="mb-4 text-xs text-muted-foreground">
        Seizure and CNS-disease recordings, ingested the same way as the sedation and
        ICU material: a sample CSV with one column per channel, plus an optional
        annotation CSV of <code>start,stop,label</code> intervals. An event labels an
        epoch only when it covers at least half of it, and only annotation-derived
        labels count as ground truth — everything this app computes stays marked as
        derived. Nothing here feeds depth calibration.
      </p>
      <div className="space-y-3">
        {PATHOLOGY_DATASETS.map((d) => (
          <DatasetCard key={d.id} info={d} />
        ))}
      </div>
    </section>
  );
}

function DatasetCard({ info }: { info: PathologyDatasetInfo }) {
  const [annotations, setAnnotations] = useState<{
    name: string;
    events: PathologyAnnotation[];
  } | null>(null);
  const signalRef = useRef<HTMLInputElement>(null);
  const annotationRef = useRef<HTMLInputElement>(null);

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
      dataset: PathologyDataset;
      files: File[];
    }) => {
      const meta = pathologyDataset(dataset);
      const epochs: PhysionetEpoch[] = [];
      const transforms = new Set<string>();

      for (const file of files) {
        const caseRef = caseRefFromName(file.name);
        const recording = parseSedationIcuCsv(await file.text(), meta.sampleRate);
        recording.channels.forEach((channel, i) => {
          const signal = recording.signals[i];
          if (!signal) return;
          const derived = epochsFromPathologyRecording(signal, recording.sampleRate, {
            dataset,
            caseRef,
            channel,
            ...(annotations ? { annotations: annotations.events } : {}),
          });
          if (!derived.length) return;
          const inferred = inferReference(channel);
          const harmonized = harmonizeEpochs(derived, {
            ...meta.montage,
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
        data: { epochs: toPathologyRows(dataset, epochs) },
      });
      return { result, labels: summarisePathologyLabels(epochs), transforms: [...transforms] };
    },
    onSuccess: ({ result, labels, transforms }) => {
      toast.success(
        `Imported ${result.inserted} epochs from ${result.cases} case(s)` +
          (result.skipped ? ` — ${result.skipped} already stored` : ""),
        {
          description:
            (labels.labelled
              ? `${labels.labelled} epochs carry expert labels, ${labels.seizureEpochs} of them seizure. `
              : "No annotation file was applied — these epochs have no ground-truth labels. ") +
            (transforms.length ? `Harmonised: ${transforms.join(" | ")}` : ""),
        },
      );
      void pool.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const loadAnnotations = async (file: File) => {
    try {
      const events = parsePathologyAnnotations(await file.text());
      if (!events.length) throw new Error("No usable annotation rows were found.");
      setAnnotations({ name: file.name, events });
      toast.success(`${events.length} annotation events ready for ${info.label}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read the annotation file.");
    }
  };

  const stored = (pool.data?.byLineage ?? []).find(
    (g: PoolGroup) => g.lineage === info.lineage,
  );

  const CATEGORY_META: Record<PathologyCategory, { label: string; Icon: typeof Zap }> = {
    seizure: { label: "Seizure", Icon: Zap },
    "cns-disease": { label: "CNS disease", Icon: Brain },
    suppression: { label: "Suppression", Icon: Activity },
  };
  const { label: categoryLabel, Icon } = CATEGORY_META[info.category];

  return (
    <article className="rounded-md border border-border/60 p-3">
      <header className="mb-1 flex flex-wrap items-center gap-2">
        <Icon
          className={cn(
            "h-3.5 w-3.5",
            info.category === "seizure" ? "text-destructive" : "text-primary",
          )}
          aria-hidden
        />
        <h4 className="text-xs font-semibold">{info.label}</h4>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          {categoryLabel}
        </span>
      </header>
      <p className="text-xs text-muted-foreground">{info.description}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {info.sampleRate} Hz · {info.montage.note} Annotations: {info.annotations}
      </p>
      <p className="text-[11px] text-muted-foreground">Licence: {info.licence}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          ref={annotationRef}
          type="file"
          accept=".csv,.txt,.csv_bi,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void loadAnnotations(file);
            e.target.value = "";
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11"
          onClick={() => annotationRef.current?.click()}
        >
          <FileText className="mr-2 h-4 w-4" />
          {annotations ? "Change annotations" : "Load annotations"}
        </Button>

        <input
          ref={signalRef}
          type="file"
          accept=".csv,.txt,text/csv"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length) {
              importMutation.mutate({ dataset: info.id, files: Array.from(files) });
            }
            e.target.value = "";
          }}
        />
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          disabled={importMutation.isPending}
          onClick={() => signalRef.current?.click()}
        >
          {importMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-2 h-4 w-4" />
          )}
          Import recordings
        </Button>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        {annotations
          ? `Using ${annotations.events.length} events from ${annotations.name}.`
          : "No annotation file loaded — imported epochs will have no ground-truth labels."}
      </p>

      {stored ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Stored: {stored.epochs.toLocaleString()} epochs · {stored.cases} case(s)
          {stored.labels.length
            ? ` · ${stored.labels
                .slice(0, 4)
                .map((l) => `${l.label}: ${l.count}`)
                .join(" · ")}`
            : ""}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">Nothing stored yet.</p>
      )}
    </article>
  );
}
