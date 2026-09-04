import { useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, Upload } from "lucide-react";
import { toast } from "sonner";

import { AppNav } from "@/components/AppNav";
import { DsaGridPanel } from "@/components/monitor/DsaGridPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCoebisModel } from "@/hooks/useCoebisModel";
import { formatClock } from "@/lib/eeg/format";
import { guessColumns, medianInterval, parseDelimited, readSeries } from "@/lib/eeg/agreement";
import { AGE_BANDS, FRAILTY_LEVELS, REGIMENS, type CaseCovariates } from "@/lib/eeg/covariates";
import { replayRawEeg, type ReplayResult } from "@/lib/eeg/replay";
import { getExternalPriors } from "@/lib/eeg/vitaldb.functions";

export const Route = createFileRoute("/_authenticated/_admin/replay")({
  head: () => ({
    meta: [
      { title: "COEBIS replay dashboard — CortexTrace" },
      {
        name: "description",
        content:
          "Replay a real EEG recording through the COEBIS estimator and compare predicted depth against the commercial BIS readings second by second.",
      },
      { property: "og:title", content: "COEBIS replay dashboard — CortexTrace" },
      {
        property: "og:description",
        content:
          "Upload a real EEG file to see the DSA, power, suppression and SEF95 alongside COEBIS predictions, agreement metrics and the external covariate prior.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Replay,
});

const NONE = "__none__";

function Replay() {
  const alignment = useCoebisModel();
  const fileRef = useRef<HTMLInputElement>(null);
  const [table, setTable] = useState<ReturnType<typeof parseDelimited> | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [eegCol, setEegCol] = useState<number | null>(null);
  const [bisCol, setBisCol] = useState<number | null>(null);
  const [timeCol, setTimeCol] = useState<number | null>(null);
  const [sampleRate, setSampleRate] = useState("250");
  const [cov, setCov] = useState<CaseCovariates>({});
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [busy, setBusy] = useState(false);

  const priors = useQuery({
    queryKey: ["external-priors"],
    queryFn: () => getExternalPriors(),
  });

  async function onFile(file: File) {
    const parsed = parseDelimited(await file.text());
    if (!parsed.rows.length) {
      toast.error("That file had no readable rows.");
      return;
    }
    const guess = guessColumns(parsed);
    setTable(parsed);
    setFileName(file.name);
    setTimeCol(guess.timeColumn);
    setEegCol(guess.eegColumn ?? guess.indexColumn);
    setBisCol(guess.eegColumn !== null ? guess.indexColumn : null);
    setResult(null);
  }

  function run() {
    if (!table || eegCol === null) {
      toast.error("Choose the raw EEG column first.");
      return;
    }
    const fs = Number(sampleRate);
    if (!Number.isFinite(fs) || fs <= 0) {
      toast.error("Enter the sample rate of the EEG column.");
      return;
    }
    setBusy(true);
    try {
      const eeg = readSeries(table, timeCol, eegCol, fs).map((p) => p.v);
      const bis = bisCol === null ? [] : readSeries(table, timeCol, bisCol, 1);
      const spacing = bis.length > 1 ? medianInterval(bis) : 5;
      const replay = replayRawEeg({
        samples: eeg,
        sampleRate: fs,
        bis,
        alignment,
        covariates: cov,
        toleranceSeconds: Math.max(2, Math.min(30, spacing)),
        priors: priors.data?.groups ?? [],
      });
      setResult(replay);
      if (!replay.frames.length) toast.error(replay.notes[0] ?? "Nothing to replay.");
      else toast.success(`Replayed ${replay.frames.length}s of EEG.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Replay failed.");
    } finally {
      setBusy(false);
    }
  }

  const timeline = useMemo(
    () =>
      (result?.frames ?? []).map((f) => ({
        t: f.t,
        coebis: f.coebis,
        bis: f.bis,
        index: f.appIndex,
        // Recharts stacks an area band as [floor, height].
        band:
          f.coebisLower == null || f.coebisUpper == null
            ? null
            : [f.coebisLower, f.coebisUpper],
      })),
    [result],
  );

  const columnOptions = table
    ? table.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` }))
    : [];

  return (
    <div className="min-h-dvh bg-background p-4 sm:p-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/">
              <ArrowLeft className="size-4" /> Monitor
            </Link>
          </Button>
          <h1 className="text-lg font-semibold">COEBIS replay</h1>
        </div>
        <AppNav showBrand={false} compact />
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Replay a real recording through the live estimator. The file needs a raw EEG column; if it
        also carries the commercial monitor's BIS, the dashboard scores COEBIS against it second by
        second and sets the result beside the external covariate prior.
      </p>

      <section className="mb-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">Recording</Label>
            <div className="mt-1 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload className="size-4" /> Choose CSV
              </Button>
              <span className="text-xs text-muted-foreground">{fileName ?? "No file yet"}</span>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt,.tsv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
            </div>
          </div>

          {table ? (
            <>
              <ColumnSelect
                label="Time column"
                value={timeCol}
                options={columnOptions}
                onChange={setTimeCol}
                allowNone
              />
              <ColumnSelect
                label="Raw EEG"
                value={eegCol}
                options={columnOptions}
                onChange={setEegCol}
              />
              <ColumnSelect
                label="Monitor BIS"
                value={bisCol}
                options={columnOptions}
                onChange={setBisCol}
                allowNone
              />
              <div className="w-28">
                <Label className="text-xs">Sample rate (Hz)</Label>
                <Input
                  className="mt-1 h-9"
                  value={sampleRate}
                  onChange={(e) => setSampleRate(e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <CovSelect
            label="Age band"
            value={cov.ageBand ?? null}
            options={AGE_BANDS.map((a) => ({ value: a, label: a }))}
            onChange={(v) => setCov((c) => ({ ...c, ageBand: v }))}
          />
          <CovSelect
            label="Sex"
            value={cov.sex ?? null}
            options={[
              { value: "male", label: "Male" },
              { value: "female", label: "Female" },
            ]}
            onChange={(v) => setCov((c) => ({ ...c, sex: v }))}
          />
          <CovSelect
            label="Regimen"
            value={cov.regimen ?? null}
            options={REGIMENS.map((r) => ({ value: r.key, label: r.label }))}
            onChange={(v) => setCov((c) => ({ ...c, regimen: v }))}
          />
          <CovSelect
            label="Frailty"
            value={cov.frailty ?? null}
            options={FRAILTY_LEVELS.map((f) => ({ value: f.key, label: f.label }))}
            onChange={(v) => setCov((c) => ({ ...c, frailty: v }))}
          />
          <Button size="sm" disabled={!table || busy} onClick={run}>
            {busy ? "Replaying…" : "Run COEBIS replay"}
          </Button>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          {alignment
            ? `Using fitted COEBIS model${alignment.version ? ` v${alignment.version}` : ""} (n=${alignment.n} paired readings).`
            : "No fitted COEBIS model yet — predictions fall back to the unaligned index."}
        </p>
      </section>

      {result?.frames.length ? (
        <div className="space-y-4">
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">DSA grid — power, suppression and SEF95</h2>
            <DsaGridPanel frames={result.frames} />
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-1 text-sm font-semibold">COEBIS prediction vs monitor BIS</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              The shaded band is the{" "}
              {Math.round((result.intervalLevel ?? 0.9) * 100)}% prediction interval: how much room
              the model needs for its own fitted error, this patient&apos;s covariates, signal
              quality, suppression and how fast the index is moving.
            </p>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={timeline} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(t: number) => formatClock(t)}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                  />
                  <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip labelFormatter={(t: number) => formatClock(t)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area
                    type="monotone"
                    dataKey="band"
                    name={`COEBIS ${Math.round((result.intervalLevel ?? 0.9) * 100)}% interval`}
                    stroke="none"
                    fill="hsl(var(--signal))"
                    fillOpacity={0.16}
                    connectNulls
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="bis"
                    name="Monitor BIS"
                    dot={false}
                    connectNulls
                    stroke="hsl(var(--muted-foreground))"
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="index"
                    name="Raw index"
                    dot={false}
                    connectNulls
                    strokeDasharray="4 3"
                    stroke="hsl(var(--primary))"
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="coebis"
                    name="COEBIS"
                    dot={false}
                    connectNulls
                    stroke="hsl(var(--signal))"
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Paired seconds" value={result.metrics?.n ?? 0} />
              <Stat label="Bias" value={fmt(result.metrics?.bias)} />
              <Stat label="MAE" value={fmt(result.metrics?.mae)} />
              <Stat
                label="Within 10"
                value={
                  result.metrics ? `${Math.round(result.metrics.within10 * 100)} %` : "—"
                }
              />
            </div>
            {result.calibration ? (
              <div className="mt-3 rounded-md border border-border/60 p-3">
                <p className="text-xs font-medium text-foreground">
                  Interval calibration against the monitor
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{result.calibration.summary}</p>
                {result.calibration.levels.length ? (
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {result.calibration.levels.map((l) => (
                      <Stat
                        key={l.nominal}
                        label={`${Math.round(l.nominal * 100)}% band coverage`}
                        value={`${Math.round(l.empirical * 100)} %`}
                      />
                    ))}
                    <Stat
                      label="Spread ratio"
                      value={fmt(result.calibration.zSpread, 2)}
                    />
                    <Stat
                      label="Mean width (90%)"
                      value={fmt(
                        result.calibration.levels.find((l) => l.nominal === 0.9)?.meanWidth,
                      )}
                    />
                  </div>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  Spread ratio is the SD of (monitor − COEBIS) ÷ quoted spread: 1.0 means the band
                  is the right size, above 1.0 means it is too narrow.
                </p>
              </div>
            ) : null}
            {result.baselineMetrics ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Unaligned index for comparison: bias {fmt(result.baselineMetrics.bias)}, MAE{" "}
                {fmt(result.baselineMetrics.mae)}, CCC {fmt(result.baselineMetrics.ccc)}.
              </p>
            ) : null}
            {result.notes.map((n) => (
              <p key={n} className="mt-1 text-xs text-caution">
                {n}
              </p>
            ))}
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">
              Per-covariate breakdown vs external prior
            </h2>
            {result.covariates.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-1 pr-3">Covariate</th>
                      <th className="py-1 pr-3">Level</th>
                      <th className="py-1 pr-3">Seconds</th>
                      <th className="py-1 pr-3">Mean COEBIS</th>
                      <th className="py-1 pr-3">Mean monitor BIS</th>
                      <th className="py-1 pr-3">Bias</th>
                      <th className="py-1 pr-3">Prior mean BIS</th>
                      <th className="py-1">Prior cases</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.covariates.map((r) => (
                      <tr key={`${r.group}-${r.level}`} className="border-t border-border/60">
                        <td className="py-1 pr-3 capitalize">{r.group}</td>
                        <td className="py-1 pr-3">{r.levelLabel}</td>
                        <td className="py-1 pr-3 metric-value">{r.n}</td>
                        <td className="py-1 pr-3 metric-value">{r.meanCoebis ?? "—"}</td>
                        <td className="py-1 pr-3 metric-value">{r.meanBis ?? "—"}</td>
                        <td className="py-1 pr-3 metric-value">{r.bias ?? "—"}</td>
                        <td className="py-1 pr-3 metric-value">{r.priorBis ?? "—"}</td>
                        <td className="py-1 metric-value">{r.priorCases ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Set the case covariates above to compare this recording with the imported external
                pool.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function fmt(v: number | null | undefined, dp = 1) {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="metric-value text-lg">{value}</p>
    </div>
  );
}

function ColumnSelect({
  label,
  value,
  options,
  onChange,
  allowNone = false,
}: {
  label: string;
  value: number | null;
  options: { value: string; label: string }[];
  onChange: (v: number | null) => void;
  allowNone?: boolean;
}) {
  return (
    <div className="w-40">
      <Label className="text-xs">{label}</Label>
      <Select
        value={value === null ? NONE : String(value)}
        onValueChange={(v) => onChange(v === NONE ? null : Number(v))}
      >
        <SelectTrigger className="mt-1 h-9">
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent>
          {allowNone ? <SelectItem value={NONE}>None</SelectItem> : null}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CovSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="w-40">
      <Label className="text-xs">{label}</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(v) => onChange(v === NONE ? null : v)}
      >
        <SelectTrigger className="mt-1 h-9">
          <SelectValue placeholder="Unknown" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Unknown</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
