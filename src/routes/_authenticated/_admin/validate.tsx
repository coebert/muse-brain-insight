import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, ArrowLeft, Download, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { unseal } from "@/lib/privacy";
import { formatClock } from "@/lib/eeg/format";
import {
  agreementMetrics,
  agreementVerdict,
  alignSeries,
  bestLagSeconds,
  buildPairedCsv,
  buildReportMarkdown,
  depthFromSamples,
  guessColumns,
  medianInterval,
  parseDelimited,
  readSeries,
  type AlignedPair,
  type ParsedTable,
  type Point,
} from "@/lib/eeg/agreement";

export const Route = createFileRoute("/_authenticated/_admin/validate")({
  head: () => ({
    meta: [
      { title: "OpenIBIS agreement report — CortexTrace" },
      {
        name: "description",
        content:
          "Upload an OpenIBIS reference trace or raw EEG file and generate a Bland-Altman agreement report against the streamed depth index.",
      },
      { property: "og:title", content: "OpenIBIS agreement report — CortexTrace" },
      {
        property: "og:description",
        content:
          "Validate the streamed depth-of-anaesthesia index against a reference OpenIBIS output with correlation, bias and limits of agreement.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Validate,
});

const NONE = "__none__";
const FROM_UPLOAD = "__upload__";

function download(name: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Validate() {
  const [fileName, setFileName] = useState("");
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [timeCol, setTimeCol] = useState<string>(NONE);
  const [refCol, setRefCol] = useState<string>(NONE);
  const [eegCol, setEegCol] = useState<string>(NONE);
  const [eegHz, setEegHz] = useState(256);
  const [target, setTarget] = useState<string>("");
  const [tolerance, setTolerance] = useState(2);
  const [lag, setLag] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessions = useQuery({
    queryKey: ["eeg_sessions", "validate"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_sessions")
        .select("id, case_code, context, created_at, duration_seconds")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return unseal(data, ["case_code"]);
    },
  });

  const sessionId = target && target !== FROM_UPLOAD ? target : "";

  const epochs = useQuery({
    queryKey: ["eeg_epochs", "validate", sessionId],
    enabled: Boolean(sessionId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_epochs")
        .select("t_offset_seconds, depth_index")
        .eq("session_id", sessionId)
        .order("t_offset_seconds", { ascending: true });
      if (error) throw error;
      return data as { t_offset_seconds: number; depth_index: number | null }[];
    },
  });

  async function handleFile(file: File) {
    const text = await file.text();
    const parsed = parseDelimited(text);
    if (!parsed.rows.length) {
      toast.error("That file has no readable rows.");
      return;
    }
    const guess = guessColumns(parsed);
    setFileName(file.name);
    setTable(parsed);
    setTimeCol(guess.timeColumn === null ? NONE : String(guess.timeColumn));
    setRefCol(guess.indexColumn === null ? NONE : String(guess.indexColumn));
    setEegCol(guess.eegColumn === null ? NONE : String(guess.eegColumn));
    setLag(0);
    toast.success(`Loaded ${parsed.rows.length} rows from ${file.name}`);
  }

  const referenceSeries: Point[] = useMemo(() => {
    if (!table || refCol === NONE) return [];
    return readSeries(table, timeCol === NONE ? null : Number(timeCol), Number(refCol), 1);
  }, [table, refCol, timeCol]);

  const uploadedDepth: Point[] = useMemo(() => {
    if (!table || eegCol === NONE) return [];
    const raw = readSeries(table, timeCol === NONE ? null : Number(timeCol), Number(eegCol), eegHz);
    if (raw.length < eegHz * 10) return [];
    return depthFromSamples(
      raw.map((p) => p.v),
      eegHz,
    );
  }, [table, eegCol, timeCol, eegHz]);

  const sessionDepth: Point[] = useMemo(() => {
    return (epochs.data ?? [])
      .filter((e) => e.depth_index !== null)
      .map((e) => ({ t: Number(e.t_offset_seconds) || 0, v: Number(e.depth_index) }));
  }, [epochs.data]);

  const testSeries = target === FROM_UPLOAD ? uploadedDepth : sessionDepth;
  const testLabel =
    target === FROM_UPLOAD
      ? "Depth index recomputed from the uploaded EEG"
      : sessions.data?.find((s) => s.id === sessionId)
        ? `Streamed depth index — ${sessions.data.find((s) => s.id === sessionId)!.case_code}`
        : "Streamed depth index";

  // Default the comparison target once data is available.
  useEffect(() => {
    if (target) return;
    if (eegCol !== NONE && uploadedDepth.length) setTarget(FROM_UPLOAD);
    else if (sessions.data?.length) setTarget(sessions.data[0]!.id);
  }, [target, eegCol, uploadedDepth.length, sessions.data]);

  const pairs: AlignedPair[] = useMemo(
    () => alignSeries(referenceSeries, testSeries, tolerance, lag),
    [referenceSeries, testSeries, tolerance, lag],
  );

  const metrics = useMemo(() => agreementMetrics(pairs), [pairs]);

  const overlay = useMemo(
    () =>
      pairs.map((p) => ({
        t: p.t,
        reference: Number(p.reference.toFixed(2)),
        test: Number(p.test.toFixed(2)),
      })),
    [pairs],
  );

  const bland = useMemo(
    () =>
      pairs.map((p) => ({
        mean: Number(((p.reference + p.test) / 2).toFixed(2)),
        diff: Number((p.test - p.reference).toFixed(2)),
      })),
    [pairs],
  );

  function autoAlign() {
    if (!referenceSeries.length || !testSeries.length) return;
    const best = bestLagSeconds(referenceSeries, testSeries, tolerance, 60, 1);
    setLag(best.lag);
    toast.success(
      best.r === null
        ? "No usable alignment found."
        : `Best alignment at ${best.lag} s (r = ${best.r.toFixed(3)})`,
    );
  }

  function exportReport() {
    const md = buildReportMarkdown(
      metrics,
      {
        fileName: fileName || "uploaded file",
        sourceLabel:
          table && refCol !== NONE ? (table.headers[Number(refCol)] ?? "reference") : "reference",
        comparisonLabel: testLabel,
        lagSeconds: lag,
        toleranceSeconds: tolerance,
        generatedAt: new Date(),
      },
      pairs,
    );
    download("depth-agreement-report.md", md, "text/markdown");
  }

  const cadence = testSeries.length > 1 ? medianInterval(testSeries) : 1;
  const columnOptions = table?.headers ?? [];
  const fmt = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? "—" : v.toFixed(d));

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
          <Activity className="size-5 shrink-0 text-signal" />
          <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
            CortexTrace
          </span>
          <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
            <Button asChild variant="outline" size="sm">
              <Link to="/compare">Compare</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/sessions">Sessions</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/">
                <ArrowLeft className="size-4" /> Monitor
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-3 py-6 sm:px-4">
        <h1 className="text-lg font-semibold">OpenIBIS agreement report</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Upload a reference trace — the output of the published openibis.m, a recorded BIS trend,
          or a raw EEG file the reference was computed from — and CortexTrace pairs it against the
          depth index it computed, then reports correlation, bias and Bland-Altman limits of
          agreement.
        </p>

        <section className="panel mt-4 px-3 py-4 sm:px-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
            className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center"
          >
            <Upload className="size-5 text-muted-foreground" />
            <p className="text-sm">
              Drop a CSV/TSV here, or{" "}
              <button
                type="button"
                className="text-signal underline underline-offset-4"
                onClick={() => inputRef.current?.click()}
              >
                choose a file
              </button>
            </p>
            <p className="text-xs text-muted-foreground">
              Reference index files need a time column and an index column. Raw EEG files need a
              microvolt column; CortexTrace will replay them through its own estimator.
            </p>
            {fileName ? (
              <p className="metric-value text-xs text-signal">
                {fileName} · {table?.rows.length ?? 0} rows
              </p>
            ) : null}
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
                e.target.value = "";
              }}
            />
          </div>

          {table ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ColumnSelect
                label="Time column"
                value={timeCol}
                onChange={setTimeCol}
                options={columnOptions}
                allowNone="Row index"
              />
              <ColumnSelect
                label="Reference index column"
                value={refCol}
                onChange={setRefCol}
                options={columnOptions}
                allowNone="Not in this file"
              />
              <ColumnSelect
                label="Raw EEG column (µV)"
                value={eegCol}
                onChange={setEegCol}
                options={columnOptions}
                allowNone="Not in this file"
              />
              <div>
                <label className="text-xs tracking-wide text-muted-foreground uppercase">
                  EEG sample rate (Hz)
                </label>
                <input
                  type="number"
                  min={64}
                  max={1024}
                  value={eegHz}
                  onChange={(e) => setEegHz(Math.max(64, Number(e.target.value) || 256))}
                  className="mt-1 h-9 w-full rounded-md border border-border bg-input/40 px-2 text-sm"
                />
              </div>
            </div>
          ) : null}
        </section>

        {table ? (
          <section className="panel mt-4 flex flex-wrap items-end gap-4 px-3 py-3 sm:px-4">
            <div className="w-full min-w-0 sm:w-auto sm:min-w-72">
              <label className="text-xs tracking-wide text-muted-foreground uppercase">
                Compare against
              </label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue placeholder="Select a depth trend" />
                </SelectTrigger>
                <SelectContent>
                  {uploadedDepth.length ? (
                    <SelectItem value={FROM_UPLOAD}>
                      Depth recomputed from this file ({uploadedDepth.length} epochs)
                    </SelectItem>
                  ) : null}
                  {sessions.data?.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.case_code} · {new Date(s.created_at).toLocaleDateString()} ·{" "}
                      {formatClock(s.duration_seconds ?? 0)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs tracking-wide text-muted-foreground uppercase">
                Match tolerance: ±{tolerance} s
              </label>
              <input
                type="range"
                min={0.5}
                max={10}
                step={0.5}
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
                className="mt-2 block w-40 accent-signal"
              />
            </div>

            <div>
              <label className="text-xs tracking-wide text-muted-foreground uppercase">
                Time shift: {lag} s
              </label>
              <input
                type="range"
                min={-60}
                max={60}
                step={1}
                value={lag}
                onChange={(e) => setLag(Number(e.target.value))}
                className="mt-2 block w-48 accent-signal"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={autoAlign}>
                Auto-align
              </Button>
              <Button size="sm" onClick={exportReport} disabled={pairs.length < 3}>
                <Download className="size-4" /> Report (.md)
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pairs.length < 3}
                onClick={() =>
                  download("depth-agreement-pairs.csv", buildPairedCsv(pairs), "text/csv")
                }
              >
                Paired data (.csv)
              </Button>
            </div>
          </section>
        ) : null}

        {table && pairs.length < 3 ? (
          <div className="panel mt-4 px-4 py-6 text-sm text-muted-foreground">
            {referenceSeries.length === 0
              ? "Pick the column holding the reference index values."
              : testSeries.length === 0
                ? "Pick a saved case with a stored depth trend, or map a raw EEG column so the index can be recomputed."
                : "No overlapping samples yet — widen the match tolerance or try auto-align."}
          </div>
        ) : null}

        {pairs.length >= 3 ? (
          <>
            <section className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat
                label="Pearson r"
                value={fmt(metrics.r, 3)}
                sub={`${metrics.n} paired samples`}
              />
              <Stat label="Lin's CCC" value={fmt(metrics.ccc, 3)} sub="concordance" />
              <Stat
                label="Bias"
                value={fmt(metrics.bias)}
                sub={`LoA ${fmt(metrics.loaLower)} to ${fmt(metrics.loaUpper)}`}
              />
              <Stat
                label="RMSE"
                value={fmt(metrics.rmse)}
                sub={`MAE ${fmt(metrics.mae)} · ${fmt(metrics.within10, 0)} % within ±10`}
              />
            </section>

            <p className="panel mt-3 px-4 py-3 text-sm">
              {agreementVerdict(metrics)}{" "}
              <span className="text-muted-foreground">
                Regression: test = {fmt(metrics.slope, 3)} × reference + {fmt(metrics.intercept)} ·
                epoch cadence {fmt(cadence, 1)} s · shift {lag} s.
              </span>
            </p>

            <section className="panel mt-4 px-3 py-3 sm:px-4">
              <h2 className="text-sm font-semibold">Reference vs computed index</h2>
              <div className="mt-3 h-[260px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={overlay} margin={{ top: 5, right: 8, bottom: 5, left: -18 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      tickFormatter={(v: number) => formatClock(v)}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis domain={[0, 100]} stroke="var(--muted-foreground)" fontSize={11} />
                    <Tooltip
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        fontSize: 12,
                      }}
                      labelFormatter={(v: number) => formatClock(v)}
                    />
                    <Line
                      type="monotone"
                      dataKey="reference"
                      name="Reference"
                      dot={false}
                      stroke="var(--chart-2)"
                      strokeWidth={1.6}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="test"
                      name="CortexTrace"
                      dot={false}
                      stroke="var(--chart-1)"
                      strokeWidth={1.6}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="panel mt-4 px-3 py-3 sm:px-4">
              <h2 className="text-sm font-semibold">Bland-Altman</h2>
              <div className="mt-3 h-[260px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 5, right: 8, bottom: 5, left: -18 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis
                      type="number"
                      dataKey="mean"
                      name="Mean of both"
                      domain={[0, 100]}
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <YAxis
                      type="number"
                      dataKey="diff"
                      name="Difference"
                      stroke="var(--muted-foreground)"
                      fontSize={11}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        fontSize: 12,
                      }}
                    />
                    <ReferenceLine y={metrics.bias} stroke="var(--chart-1)" />
                    <ReferenceLine
                      y={metrics.loaUpper}
                      stroke="var(--chart-3)"
                      strokeDasharray="4 4"
                    />
                    <ReferenceLine
                      y={metrics.loaLower}
                      stroke="var(--chart-3)"
                      strokeDasharray="4 4"
                    />
                    <Scatter data={bland} fill="var(--chart-2)" isAnimationActive={false} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Solid line: bias. Dashed lines: 95 % limits of agreement.
              </p>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

function ColumnSelect({
  label,
  value,
  onChange,
  options,
  allowNone,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allowNone: string;
}) {
  return (
    <div>
      <label className="text-xs tracking-wide text-muted-foreground uppercase">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="mt-1 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{allowNone}</SelectItem>
          {options.map((h, i) => (
            <SelectItem key={`${h}-${i}`} value={String(i)}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="panel px-3 py-3">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="metric-value mt-1 text-2xl">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}
