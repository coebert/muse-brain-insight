import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { AppNav } from "@/components/AppNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ANALYSIS_CHANNELS, type AnalysisChannel } from "@/lib/eeg/device-profile";
import {
  corpusDeviceId,
  corpusLineageKey,
  pairCorpusCase,
  parseDepthCorpus,
  retimeByRate,
  type CorpusCaseResult,
  type CorpusParse,
} from "@/lib/eeg/depth-corpus";
import {
  getCorpusLineages,
  importDepthCorpus,
  type DepthCorpusImportResult,
} from "@/lib/eeg/depth-corpus.functions";

export const Route = createFileRoute("/_authenticated/_admin/depth-intake")({
  head: () => ({
    meta: [
      { title: "Depth corpus intake — CortexTrace" },
      {
        name: "description",
        content:
          "Upload an anaesthesia EEG corpus that carries its own depth scores, replay it through the app's estimator and pair every reading into the COEBIS pipeline.",
      },
      { property: "og:title", content: "Depth corpus intake — CortexTrace" },
      {
        property: "og:description",
        content:
          "Upload a corpus with its own depth scores and pair it into the COEBIS pipeline under its own lineage.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DepthIntakePage,
});

/** Readings and cases a lineage needs before a fit may be attempted. */
const GATE_READINGS = 30;
const GATE_CASES = 3;

interface PairedCorpus {
  cases: CorpusCaseResult[];
  readings: number;
  unmatched: number;
  noIndex: number;
  meanGap: number | null;
}

function DepthIntakePage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [parse, setParse] = useState<CorpusParse | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [corpusLabel, setCorpusLabel] = useState("");
  const [scoreLabel, setScoreLabel] = useState("BIS");
  const [licence, setLicence] = useState("");
  const [channel, setChannel] = useState<AnalysisChannel>("AF7");
  const [rateInput, setRateInput] = useState("");
  const [paired, setPaired] = useState<PairedCorpus | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [result, setResult] = useState<DepthCorpusImportResult | null>(null);

  const queryClient = useQueryClient();
  const lineagesQuery = useQuery({
    queryKey: ["corpus-lineages"],
    queryFn: () => getCorpusLineages(),
  });
  const runImport = useServerFn(importDepthCorpus);
  const importMutation = useMutation({
    mutationFn: runImport,
    onSuccess: (res) => {
      setResult(res);
      void queryClient.invalidateQueries({ queryKey: ["corpus-lineages"] });
    },
  });

  const sampleRate = useMemo(() => {
    const typed = Number(rateInput);
    if (Number.isFinite(typed) && typed > 0) return typed;
    return parse?.derivedSampleRate ?? null;
  }, [rateInput, parse]);

  const deviceId = corpusDeviceId(corpusLabel || fileName || "corpus");
  const lineage =
    sampleRate != null ? corpusLineageKey(deviceId, channel, sampleRate) : null;

  async function onFile(file: File) {
    setResult(null);
    setPaired(null);
    setPairError(null);
    setParseError(null);
    setFileName(file.name);
    if (!corpusLabel) setCorpusLabel(file.name.replace(/\.[^.]+$/, ""));
    const body = await file.text();
    setText(body);
    try {
      const next = parseDepthCorpus(body);
      setParse(next);
      if (next.derivedSampleRate != null) setRateInput(String(next.derivedSampleRate));
    } catch (e) {
      setParse(null);
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }

  function pair() {
    if (!parse || sampleRate == null) return;
    setPairing(true);
    setPairError(null);
    setResult(null);
    // Yield once so the button shows its working state before the replay runs.
    setTimeout(() => {
      try {
        const hasClock = parse.columns.time != null;
        const results = parse.cases.map((c) =>
          pairCorpusCase(hasClock ? c : retimeByRate(c, sampleRate), {
            sampleRate,
            corpusId: deviceId,
          }),
        );
        const readings = results.reduce((a, r) => a + r.points.length, 0);
        const gaps = results.flatMap((r) =>
          r.points.map((p) => Math.abs(p.reference - p.appIndex)),
        );
        setPaired({
          cases: results,
          readings,
          unmatched: results.reduce((a, r) => a + r.rejected.unmatched, 0),
          noIndex: results.reduce((a, r) => a + r.rejected.noIndex, 0),
          meanGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
        });
      } catch (e) {
        setPairError(e instanceof Error ? e.message : String(e));
      } finally {
        setPairing(false);
      }
    }, 30);
  }

  const usable = paired?.cases.filter((c) => c.points.length > 0) ?? [];
  const clearsGate =
    (paired?.readings ?? 0) >= GATE_READINGS && usable.length >= GATE_CASES;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
          <AppNav />
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold">Depth corpus intake</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Upload a recording set that carries its own depth score next to the raw signal it was
            measured from. Each recording is replayed through this app's own estimator, so every
            uploaded score ends up next to the number this app would have shown at the same second.
            A file of scores with no signal cannot be paired and is refused, with that reason given.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. The file</CardTitle>
            <CardDescription>
              A comma, tab or semicolon separated file with a header row. Columns are matched by
              name: <strong>eeg</strong> (raw microvolts, one sample per row), <strong>depth</strong>{" "}
              or <strong>bis</strong> (the corpus's own score, blank on rows between readings),
              and optionally <strong>case</strong>, <strong>time</strong> in seconds,{" "}
              <strong>sr</strong>, <strong>sef</strong> and <strong>sqi</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
              <Button onClick={() => fileRef.current?.click()}>Choose a corpus file</Button>
              {fileName ? (
                <span className="text-sm text-muted-foreground">
                  {fileName}
                  {text ? ` · ${(text.length / 1_000_000).toFixed(1)} MB` : ""}
                </span>
              ) : null}
            </div>

            {parseError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {parseError}
              </p>
            ) : null}

            {parse ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-4">
                  <Stat label="Rows read" value={parse.rows.toLocaleString()} />
                  <Stat label="Recordings" value={String(parse.cases.length)} />
                  <Stat
                    label="Depth scores"
                    value={parse.cases
                      .reduce((a, c) => a + c.scores.length, 0)
                      .toLocaleString()}
                  />
                  <Stat
                    label="Rate read from file"
                    value={parse.derivedSampleRate ? `${parse.derivedSampleRate} Hz` : "not stated"}
                  />
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {(["case", "time", "eeg", "depth", "sr", "sef", "sqi"] as const).map((role) => {
                    const idx = parse.columns[role];
                    return (
                      <Badge key={role} variant={idx == null ? "outline" : "secondary"}>
                        {role}: {idx == null ? "not found" : parse.headers[idx]}
                      </Badge>
                    );
                  })}
                </div>
                {parse.issues.length ? (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {parse.issues.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. What it is</CardTitle>
            <CardDescription>
              These details decide which fit the readings may join. A corpus always gets its own
              lineage, so nothing it contributes is pooled into another device's model.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Corpus name">
              <Input
                value={corpusLabel}
                onChange={(e) => setCorpusLabel(e.target.value)}
                placeholder="e.g. Theatre 4 propofol series"
              />
            </Field>
            <Field label="What the score is">
              <Input
                value={scoreLabel}
                onChange={(e) => setScoreLabel(e.target.value)}
                placeholder="BIS, PSi, entropy…"
              />
            </Field>
            <Field label="Electrode position">
              <Select value={channel} onValueChange={(v) => setChannel(v as AnalysisChannel)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANALYSIS_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Sample rate (Hz)">
              <Input
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value)}
                inputMode="numeric"
                placeholder="128"
              />
            </Field>
            <Field label="Licence or permission (optional)">
              <Input
                value={licence}
                onChange={(e) => setLicence(e.target.value)}
                placeholder="CC BY 4.0, local audit approval…"
              />
            </Field>
            <Field label="Lineage it will be filed under">
              <div className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
                {lineage ?? "state a sample rate first"}
              </div>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. Replay and pair</CardTitle>
            <CardDescription>
              Every recording is replayed a second at a time. A score with no replayed second within
              two seconds of it is dropped and counted, never stretched onto the nearest frame.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={pair}
                disabled={!parse || sampleRate == null || pairing}
                variant="secondary"
              >
                {pairing ? "Replaying…" : "Replay and pair"}
              </Button>
              {sampleRate != null && sampleRate < 128 ? (
                <span className="text-xs text-caution">
                  Below 128 Hz the 45 Hz band cannot be reconstructed; readings stay in their own
                  lineage and are marked as such.
                </span>
              ) : null}
            </div>

            {pairError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {pairError}
              </p>
            ) : null}

            {paired ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <Stat label="Paired readings" value={paired.readings.toLocaleString()} />
                  <Stat label="Recordings paired" value={String(usable.length)} />
                  <Stat
                    label="Average gap"
                    value={paired.meanGap == null ? "—" : `${paired.meanGap.toFixed(2)} points`}
                  />
                  <Stat
                    label="Dropped"
                    value={`${paired.unmatched + paired.noIndex}`}
                  />
                </div>

                <p className="text-sm text-muted-foreground">
                  {clearsGate
                    ? `This clears the bar for a fit of its own: ${GATE_READINGS} readings across ${GATE_CASES} recordings.`
                    : `Not enough yet for a fit of its own — the bar is ${GATE_READINGS} readings across ${GATE_CASES} recordings. The readings still count towards benchmarking and grading.`}
                </p>

                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recording</TableHead>
                        <TableHead className="text-right">Length</TableHead>
                        <TableHead className="text-right">Paired</TableHead>
                        <TableHead className="text-right">Dropped</TableHead>
                        <TableHead className="text-right">Average gap</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paired.cases.map((c) => {
                        const gaps = c.points.map((p) => Math.abs(p.reference - p.appIndex));
                        const mean = gaps.length
                          ? gaps.reduce((a, b) => a + b, 0) / gaps.length
                          : null;
                        return (
                          <TableRow key={c.caseRef}>
                            <TableCell className="font-medium">{c.caseRef}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {(c.seconds / 60).toFixed(1)} min
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {c.points.length}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {c.rejected.unmatched + c.rejected.noIndex}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {mean == null ? "—" : mean.toFixed(2)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    disabled={!usable.length || !lineage || importMutation.isPending}
                    onClick={() =>
                      importMutation.mutate({
                        data: {
                          corpusId: deviceId,
                          corpusLabel: corpusLabel || fileName || deviceId,
                          lineageKey: lineage!,
                          deviceId,
                          channel,
                          sampleRate: sampleRate!,
                          scoreLabel: scoreLabel || "depth score",
                          licence: licence.trim() || null,
                          cases: usable.map((c) => ({
                            caseRef: c.caseRef,
                            points: c.points,
                          })),
                        },
                      })
                    }
                  >
                    {importMutation.isPending ? "Filing…" : "File into the pipeline"}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Filing the same file twice adds nothing the second time: each reading is tagged
                    to its recording and second.
                  </span>
                </div>

                {importMutation.isError ? (
                  <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                    {(importMutation.error as Error).message}
                  </p>
                ) : null}

                {result ? (
                  <p className="rounded-md border border-signal/40 bg-signal/5 p-3 text-sm">
                    Filed {result.inserted.toLocaleString()} readings across {result.cases}{" "}
                    recordings under <span className="font-mono text-xs">{result.lineageKey}</span>
                    {result.skipped
                      ? `; ${result.skipped.toLocaleString()} were already on file and were left alone.`
                      : "."}
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Corpora already filed</CardTitle>
            <CardDescription>
              Uploaded corpora only. Each keeps its own lineage and is scored separately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {lineagesQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Counting…</p>
            ) : lineagesQuery.data?.lineages.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lineage</TableHead>
                    <TableHead className="text-right">Readings</TableHead>
                    <TableHead className="text-right">Recordings</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lineagesQuery.data.lineages.map((l) => {
                    const ok = l.readings >= GATE_READINGS && l.cases >= GATE_CASES;
                    return (
                      <TableRow key={l.lineageKey}>
                        <TableCell className="font-mono text-xs break-all">
                          {l.lineageKey}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {l.readings.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{l.cases}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={ok ? "secondary" : "outline"}>
                            {ok ? "ready to fit" : `${l.readings}/${GATE_READINGS} readings`}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing uploaded yet. The first corpus filed here will appear with its own lineage.
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
