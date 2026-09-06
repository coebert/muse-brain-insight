import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { AppNav } from "@/components/AppNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  UPLOAD_PRESETS,
  parseUploadAnnotations,
  parseUploadedRecording,
  uploadCaseRef,
  type UploadParseResult,
  type UploadPreset,
} from "@/lib/eeg/corpus-upload";
import type { PathologyAnnotation } from "@/lib/eeg/pathology-datasets";
import { getPhysionetPool, importPhysionet } from "@/lib/eeg/physionet.functions";

export const Route = createFileRoute("/_authenticated/_admin/corpus-upload")({
  head: () => ({
    meta: [
      { title: "Corpus upload — CortexTrace" },
      {
        name: "description",
        content:
          "Upload BDSP, BOAS and OpenNeuro sleep recordings by hand, label them from their own annotation files and add them to the training pool under their own lineage.",
      },
      { property: "og:title", content: "Corpus upload — CortexTrace" },
      {
        property: "og:description",
        content:
          "Upload real EEG recordings from BDSP, BOAS and OpenNeuro sleep records into the training pool.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CorpusUploadPage,
});

interface AnnotationState {
  fileName: string;
  annotations: PathologyAnnotation[];
  rows: number;
  skipped: number;
  labels: { label: string; count: number }[];
}

function CorpusUploadPage() {
  const [presetId, setPresetId] = useState(UPLOAD_PRESETS[0]!.id);
  const preset = UPLOAD_PRESETS.find((p) => p.id === presetId)!;
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
          <AppNav />
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold">Corpus upload</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            These three collections cannot be fetched automatically — one needs your own account,
            the others are published a night at a time. Download a recording yourself and upload it
            here. Each recording is decoded, labelled only from the annotation file you supply, and
            filed under its own lineage, so it can inform the shared priors and grading without ever
            being pooled into the headband's own fit.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {UPLOAD_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPresetId(p.id)}
              className={`rounded-lg border p-4 text-left transition ${
                p.id === presetId ? "border-signal bg-signal/5" : "hover:bg-muted/40"
              }`}
            >
              <p className="text-sm font-medium">{p.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{p.blurb}</p>
              <p className="mt-2 text-xs text-muted-foreground">{p.licence}</p>
            </button>
          ))}
        </div>

        <UploadPanel key={preset.id} preset={preset} />
        <PoolCard />
      </main>
    </div>
  );
}

function UploadPanel({ preset }: { preset: UploadPreset }) {
  const edfRef = useRef<HTMLInputElement>(null);
  const annRef = useRef<HTMLInputElement>(null);
  const [caseRef, setCaseRef] = useState("");
  const [annotation, setAnnotation] = useState<AnnotationState | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [parse, setParse] = useState<UploadParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const queryClient = useQueryClient();
  const runImport = useServerFn(importPhysionet);
  const importMutation = useMutation({
    mutationFn: runImport,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["physionet-pool"] }),
  });
  const runFileTimeline = useServerFn(fileCorpusTimeline);
  const timelineMutation = useMutation({ mutationFn: runFileTimeline });

  async function onAnnotationFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const read = parseUploadAnnotations(text, preset.labelStyle);
      setAnnotation({ fileName: file.name, ...read });
      setParse(null);
    } catch (e) {
      setAnnotation(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onEdfFile(file: File) {
    setError(null);
    setParse(null);
    setFileName(file.name);
    if (!caseRef) setCaseRef(uploadCaseRef(file.name));
    const buf = await file.arrayBuffer();
    setBytes(new Uint8Array(buf));
  }

  function decode() {
    if (!bytes || !fileName) return;
    setWorking(true);
    setError(null);
    setTimeout(() => {
      try {
        setParse(
          parseUploadedRecording(bytes, {
            preset,
            fileName,
            ...(caseRef ? { caseRef } : {}),
            annotations: annotation?.annotations ?? [],
          }),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setWorking(false);
      }
    }, 30);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{preset.label}</CardTitle>
        <CardDescription>
          {preset.access} Lineage <code>{preset.lineage}</code>. {preset.use}{" "}
          <a
            href={preset.homepage}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Open the record
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Recording file (EDF)</Label>
            <input
              ref={edfRef}
              type="file"
              accept=".edf,.EDF,.bdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onEdfFile(f);
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => edfRef.current?.click()}>
                Choose recording
              </Button>
              {fileName ? (
                <span className="text-sm text-muted-foreground">
                  {fileName}
                  {bytes ? ` · ${(bytes.length / 1_000_000).toFixed(1)} MB` : ""}
                </span>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label>
              {preset.labelStyle === "sleep" ? "Sleep stages" : "Burst/suppression intervals"}{" "}
              (optional)
            </Label>
            <input
              ref={annRef}
              type="file"
              accept=".tsv,.csv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onAnnotationFile(f);
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="outline" onClick={() => annRef.current?.click()}>
                Choose label file
              </Button>
              {annotation ? (
                <span className="text-sm text-muted-foreground">
                  {annotation.fileName} · {annotation.annotations.length.toLocaleString()} intervals
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">none — epochs stay unlabelled</span>
              )}
            </div>
          </div>
        </div>

        {annotation?.labels.length ? (
          <div className="flex flex-wrap gap-2">
            {annotation.labels.map((l) => (
              <Badge key={l.label} variant="secondary">
                {l.label}: {l.count.toLocaleString()}
              </Badge>
            ))}
            {annotation.skipped ? (
              <Badge variant="outline">{annotation.skipped} rows unreadable</Badge>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="case-ref">Recording reference</Label>
            <Input
              id="case-ref"
              value={caseRef}
              onChange={(e) => setCaseRef(e.target.value)}
              placeholder="sub-01_ses-01"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button onClick={decode} disabled={!bytes || working}>
            {working ? "Reading the recording…" : "Read and label"}
          </Button>
          <Button
            variant="secondary"
            disabled={!parse || importMutation.isPending}
            onClick={() => {
              if (parse) importMutation.mutate({ data: { epochs: parse.rows } });
            }}
          >
            {importMutation.isPending ? "Adding…" : "Add to the training pool"}
          </Button>
          <Button
            variant="outline"
            disabled={!parse || timelineMutation.isPending}
            onClick={() => {
              if (!parse) return;
              timelineMutation.mutate({
                data: {
                  caseRef: caseRef || uploadCaseRef(fileName ?? "recording"),
                  corpusId: preset.id,
                  corpusLabel: preset.label,
                  channel: parse.channel,
                  sampleRate: parse.sampleRate,
                  readings: parse.timeline,
                },
              });
            }}
          >
            {timelineMutation.isPending ? "Filing…" : "Add to the case timeline"}
          </Button>
        </div>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {importMutation.isError ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {(importMutation.error as Error).message}
          </p>
        ) : null}
        {timelineMutation.isError ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {(timelineMutation.error as Error).message}
          </p>
        ) : null}
        {timelineMutation.data ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm">
            Filed as case <strong>{timelineMutation.data.caseCode}</strong> with{" "}
            {timelineMutation.data.epochs.toLocaleString()} readings — open it from Cases to see the
            trace.
          </p>
        ) : null}

        {parse ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Channel read" value={parse.channel} />
              <Stat label="Sample rate" value={`${Math.round(parse.sampleRate)} Hz`} />
              <Stat
                label="Length"
                value={`${(parse.durationSeconds / 60).toFixed(1)} min`}
              />
              <Stat label="Readings" value={parse.rows.length.toLocaleString()} />
              <Stat label="Labelled" value={parse.labelledEpochs.toLocaleString()} />
              <Stat label="Suppressed" value={parse.suppressedEpochs.toLocaleString()} />
            </div>
            {parse.labels.length ? (
              <div className="flex flex-wrap gap-2">
                {parse.labels.map((l) => (
                  <Badge key={l.label}>
                    {l.label}: {l.count.toLocaleString()}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No labels were supplied, so these readings are stored unlabelled and can only inform
                the signal priors.
              </p>
            )}
          </div>
        ) : null}

        {importMutation.data ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm">
            Added {importMutation.data.inserted.toLocaleString()} readings across{" "}
            {importMutation.data.cases} recording(s).{" "}
            {importMutation.data.skipped
              ? `${importMutation.data.skipped.toLocaleString()} were already held and were not counted twice.`
              : ""}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PoolCard() {
  const poolQuery = useQuery({ queryKey: ["physionet-pool"], queryFn: () => getPhysionetPool() });
  const pool = poolQuery.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">What the training pool holds</CardTitle>
        <CardDescription>
          Every collection kept separately, with the labels it contributes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {poolQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !pool?.byLineage.length ? (
          <p className="text-sm text-muted-foreground">Nothing filed yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Collection</TableHead>
                <TableHead className="text-right">Readings</TableHead>
                <TableHead className="text-right">Recordings</TableHead>
                <TableHead className="text-right">Suppressed</TableHead>
                <TableHead>Labels</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pool.byLineage.map((l) => (
                <TableRow key={l.lineage}>
                  <TableCell className="font-mono text-xs">{l.lineage}</TableCell>
                  <TableCell className="text-right">{l.epochs.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{l.cases.toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    {l.suppressedEpochs.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {l.labels.map((x) => `${x.label} ${x.count}`).join(", ") || "unlabelled"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}
