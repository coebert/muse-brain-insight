import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, SlidersHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { supabase } from "@/integrations/supabase/client";
import { formatClock } from "@/lib/eeg/format";
import {
  DEFAULT_DEPTH_CALIBRATION,
  isDefaultCalibration,
  setActiveDepthCalibration,
  type DepthCalibration,
} from "@/lib/eeg/depth";
import {
  addLabel,
  buildSamples,
  deleteCalibration,
  deleteLabel,
  evaluate,
  fetchCalibrations,
  fetchLabels,
  fitCalibration,
  loadStoredCalibration,
  saveCalibration,
  setActiveStored,
  STATE_LABELS,
  stateLabelName,
  storeCalibration,
  TARGETS,
  type CalibrationSample,
  type FitResult,
  type StateLabel,
} from "@/lib/eeg/calibration";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/calibrate")({
  head: () => ({
    meta: [
      { title: "Depth index calibration — CortexTrace" },
      {
        name: "description",
        content:
          "Label awake, sedated, anaesthesia and burst-suppression periods on your recordings and refit the OpenIBIS-style sigmoid weights to your own data.",
      },
      { property: "og:title", content: "Depth index calibration — CortexTrace" },
      {
        property: "og:description",
        content:
          "Fit the depth-of-anaesthesia sigmoid weights on labelled periods from your own EEG sessions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Calibrate,
});

interface EpochRow {
  t_offset_seconds: number;
  depth_index: number | null;
  depth_components: unknown;
}

const LABEL_COLOUR: Record<StateLabel, string> = {
  awake: "var(--color-caution, #eab308)",
  sedated: "var(--color-signal, #2dd4bf)",
  anaesthesia: "#60a5fa",
  burst_suppression: "var(--color-critical, #f87171)",
};

const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—");
const num = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");

function Calibrate() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string>("");
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [pendingEnd, setPendingEnd] = useState<number | null>(null);
  const [fit, setFit] = useState<FitResult | null>(null);
  const [fitting, setFitting] = useState(false);
  const [name, setName] = useState("");
  const [active, setActive] = useState<DepthCalibration>(DEFAULT_DEPTH_CALIBRATION);

  useEffect(() => {
    const stored = loadStoredCalibration();
    if (stored) {
      setActive(stored);
      setActiveDepthCalibration(stored);
    }
  }, []);

  const sessions = useQuery({
    queryKey: ["calibrate", "sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_sessions")
        .select("id, case_code, started_at, duration_seconds, context")
        .order("started_at", { ascending: false });
      if (error) throw error;
      return unseal(data ?? [], ["case_code"]);
    },
  });

  useEffect(() => {
    if (!sessionId && sessions.data?.length) setSessionId(sessions.data[0]!.id);
  }, [sessions.data, sessionId]);

  const epochs = useQuery({
    queryKey: ["calibrate", "epochs", sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("eeg_epochs")
        .select("t_offset_seconds, depth_index, depth_components")
        .eq("session_id", sessionId)
        .order("t_offset_seconds");
      if (error) throw error;
      return (data ?? []) as EpochRow[];
    },
  });

  const labels = useQuery({
    queryKey: ["calibrate", "labels", sessionId],
    enabled: !!sessionId,
    queryFn: () => fetchLabels(sessionId),
  });

  const calibrations = useQuery({
    queryKey: ["calibrate", "saved"],
    queryFn: fetchCalibrations,
  });

  const labelledSessionIds = useMemo(
    () => (sessionId ? [sessionId] : []),
    [sessionId],
  );

  const samplesQuery = useQuery({
    queryKey: ["calibrate", "samples", labelledSessionIds, labels.data?.length ?? 0],
    enabled: labelledSessionIds.length > 0,
    queryFn: () => buildSamples(labelledSessionIds),
  });
  const samples: CalibrationSample[] = samplesQuery.data ?? [];

  const chartData = useMemo(
    () =>
      (epochs.data ?? []).map((e) => ({
        t: Number(e.t_offset_seconds),
        depth: e.depth_index === null ? null : Number(e.depth_index),
      })),
    [epochs.data],
  );

  const componentsAvailable = useMemo(
    () => (epochs.data ?? []).some((e) => e.depth_components != null),
    [epochs.data],
  );

  const handleChartClick = (state: { activeLabel?: string | number }) => {
    const t = Number(state?.activeLabel);
    if (!Number.isFinite(t)) return;
    if (pendingStart === null || pendingEnd !== null) {
      setPendingStart(t);
      setPendingEnd(null);
    } else {
      setPendingEnd(t);
    }
  };

  const applyLabel = async (label: StateLabel) => {
    if (pendingStart === null || pendingEnd === null) {
      toast.error("Click the chart twice to mark the start and end of the period.");
      return;
    }
    try {
      await addLabel(sessionId, label, pendingStart, pendingEnd);
      setPendingStart(null);
      setPendingEnd(null);
      await queryClient.invalidateQueries({ queryKey: ["calibrate", "labels", sessionId] });
      await queryClient.invalidateQueries({ queryKey: ["calibrate", "samples"] });
      toast.success(`Marked ${stateLabelName(label)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the label.");
    }
  };

  const runFit = () => {
    if (samples.length < 20) {
      toast.error("Label at least ~20 seconds of epochs across two or more states first.");
      return;
    }
    const distinct = new Set(samples.map((s) => s.label));
    if (distinct.size < 2) {
      toast.error("Label at least two different states so the fit has contrast.");
      return;
    }
    setFitting(true);
    // Nelder-Mead on a few thousand epochs is fast; yield once so the UI paints.
    setTimeout(() => {
      try {
        setFit(fitCalibration(samples));
      } finally {
        setFitting(false);
      }
    }, 10);
  };

  const activateFit = async () => {
    if (!fit) return;
    try {
      const saved = await saveCalibration(
        name.trim() || `Fit ${new Date().toLocaleString()}`,
        fit.calibration,
        fit.after,
        labelledSessionIds,
      );
      await setActiveStored(saved.id);
      storeCalibration(fit.calibration);
      setActiveDepthCalibration(fit.calibration);
      setActive(fit.calibration);
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["calibrate", "saved"] });
      toast.success("Calibration saved and applied to the live monitor.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the calibration.");
    }
  };

  const activateStored = async (id: string, params: DepthCalibration) => {
    await setActiveStored(id);
    storeCalibration(params);
    setActiveDepthCalibration(params);
    setActive(params);
    await queryClient.invalidateQueries({ queryKey: ["calibrate", "saved"] });
    toast.success("Calibration applied.");
  };

  const resetToPublished = async () => {
    await setActiveStored(null);
    storeCalibration(null);
    setActiveDepthCalibration(null);
    setActive(DEFAULT_DEPTH_CALIBRATION);
    await queryClient.invalidateQueries({ queryKey: ["calibrate", "saved"] });
    toast.success("Back to the published OpenIBIS constants.");
  };

  const currentMetrics = samples.length ? evaluate(samples, active) : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="size-5 text-signal" />
            <div>
              <h1 className="text-sm font-semibold">Depth index calibration</h1>
              <p className="text-xs text-muted-foreground">
                Label states on a recording, then refit the OpenIBIS sigmoid weights
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/compare">Compare</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/sessions">Sessions</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/">
                <ArrowLeft className="size-4" /> Monitor
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-4 px-3 py-4 sm:px-4">
        <div className="panel flex flex-wrap items-end gap-3 px-3 py-3 sm:px-4">
          <div className="w-full min-w-0 space-y-1 sm:w-auto sm:min-w-64">
            <Label className="text-xs text-muted-foreground">Session</Label>
            <Select value={sessionId} onValueChange={setSessionId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Choose a saved case" />
              </SelectTrigger>
              <SelectContent>
                {(sessions.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.case_code} — {new Date(s.started_at).toLocaleDateString()} (
                    {formatClock(s.duration_seconds ?? 0)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="text-xs text-muted-foreground">
            {isDefaultCalibration(active)
              ? "Active weights: published OpenIBIS constants"
              : "Active weights: your fitted calibration"}
          </div>
          {!isDefaultCalibration(active) ? (
            <Button variant="secondary" size="sm" onClick={() => void resetToPublished()}>
              Reset to published
            </Button>
          ) : null}
        </div>

        {!sessions.isLoading && !(sessions.data ?? []).length ? (
          <div className="panel px-4 py-6 text-sm text-muted-foreground">
            No saved sessions yet. Record and save a case on the monitor first.
          </div>
        ) : null}

        {sessionId ? (
          <section className="panel space-y-3 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Label periods</h2>
              <p className="text-xs text-muted-foreground">
                Click the chart to set the start, click again for the end, then choose a state.
              </p>
            </div>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} onClick={handleChartClick}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(v: number) => formatClock(v)}
                    stroke="currentColor"
                    fontSize={11}
                  />
                  <YAxis domain={[0, 100]} stroke="currentColor" fontSize={11} />
                  <Tooltip
                    labelFormatter={(v: number) => formatClock(Number(v))}
                    contentStyle={{ background: "hsl(var(--popover, 0 0% 10%))", fontSize: 12 }}
                  />
                  {(labels.data ?? []).map((l) => (
                    <ReferenceArea
                      key={l.id}
                      x1={l.start_seconds}
                      x2={l.end_seconds}
                      fill={LABEL_COLOUR[l.label]}
                      fillOpacity={0.16}
                      stroke={LABEL_COLOUR[l.label]}
                      strokeOpacity={0.4}
                    />
                  ))}
                  {pendingStart !== null ? (
                    <ReferenceLine x={pendingStart} stroke="#fff" strokeDasharray="4 3" />
                  ) : null}
                  {pendingEnd !== null ? (
                    <ReferenceLine x={pendingEnd} stroke="#fff" strokeDasharray="4 3" />
                  ) : null}
                  <Line
                    type="monotone"
                    dataKey="depth"
                    stroke="var(--color-signal, #2dd4bf)"
                    dot={false}
                    strokeWidth={1.6}
                    connectNulls
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Selection:{" "}
                {pendingStart === null
                  ? "none"
                  : `${formatClock(pendingStart)} → ${
                      pendingEnd === null ? "…" : formatClock(pendingEnd)
                    }`}
              </span>
              {STATE_LABELS.map((s) => (
                <Button
                  key={s.value}
                  size="sm"
                  variant="secondary"
                  disabled={pendingStart === null || pendingEnd === null}
                  onClick={() => void applyLabel(s.value)}
                >
                  <span
                    className="mr-1 inline-block size-2 rounded-full"
                    style={{ background: LABEL_COLOUR[s.value] }}
                  />
                  {s.label}
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {s.target[0]}–{s.target[1]}
                  </span>
                </Button>
              ))}
              {pendingStart !== null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPendingStart(null);
                    setPendingEnd(null);
                  }}
                >
                  Clear selection
                </Button>
              ) : null}
            </div>

            {(labels.data ?? []).length ? (
              <ul className="divide-y divide-border/50 text-xs">
                {(labels.data ?? []).map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block size-2 rounded-full"
                        style={{ background: LABEL_COLOUR[l.label] }}
                      />
                      <span className="font-medium">{stateLabelName(l.label)}</span>
                      <span className="text-muted-foreground">
                        {formatClock(l.start_seconds)} – {formatClock(l.end_seconds)} (
                        {Math.round(l.end_seconds - l.start_seconds)} s)
                      </span>
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={async () => {
                        await deleteLabel(l.id);
                        await queryClient.invalidateQueries({
                          queryKey: ["calibrate", "labels", sessionId],
                        });
                        await queryClient.invalidateQueries({ queryKey: ["calibrate", "samples"] });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No labelled periods on this case yet.</p>
            )}
          </section>
        ) : null}

        {sessionId ? (
          <section className="panel space-y-3 px-4 py-4">
            <h2 className="text-sm font-semibold">Fit sigmoid weights</h2>
            {!componentsAvailable ? (
              <p className="text-xs text-caution">
                This case was recorded before per-epoch mixer inputs were stored, so it cannot be
                used for fitting. Record a new case to calibrate.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {samples.length} labelled epochs available. Fitting shifts and stretches the
                sedation (beta ratio) and general-anaesthesia (SynchFastSlow) sigmoids so each
                labelled state falls inside its expected index band, with a pull back toward the
                published constants.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={runFit} disabled={fitting || !samples.length}>
                {fitting ? "Fitting…" : "Fit weights on labelled data"}
              </Button>
              {currentMetrics ? (
                <span className="text-xs text-muted-foreground">
                  Current weights: {pct(currentMetrics.inRangeFraction)} of labelled epochs in band,
                  RMSE {num(currentMetrics.rmse)}
                </span>
              ) : null}
            </div>

            {fit ? (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  {(
                    [
                      ["Published constants", fit.before],
                      ["Fitted weights", fit.after],
                    ] as const
                  ).map(([title, m]) => (
                    <div key={title} className="rounded-md border border-border/60 p-3">
                      <h3 className="text-xs font-semibold">{title}</h3>
                      <p className="metric-value text-lg">
                        {pct(m.inRangeFraction)}{" "}
                        <span className="text-xs text-muted-foreground">in target band</span>
                      </p>
                      <p className="text-xs text-muted-foreground">RMSE {num(m.rmse)} units</p>
                      <ul className="mt-2 space-y-1 text-xs">
                        {m.perState.map((s) => (
                          <li key={s.label} className="flex justify-between gap-2">
                            <span>
                              {stateLabelName(s.label)}{" "}
                              <span className="text-muted-foreground">({s.n})</span>
                            </span>
                            <span
                              className={cn(
                                "metric-value",
                                s.inRange >= 0.8 ? "text-signal" : "text-caution",
                              )}
                            >
                              {num(s.meanIndex, 0)} · target {TARGETS[s.label][0]}–
                              {TARGETS[s.label][1]} · {pct(s.inRange)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>

                <div className="grid gap-2 text-xs md:grid-cols-3">
                  {(["sedation", "general"] as const).map((branch) => (
                    <div key={branch} className="rounded-md border border-border/60 p-3">
                      <h3 className="text-xs font-semibold capitalize">{branch} sigmoid</h3>
                      <table className="mt-1 w-full">
                        <tbody>
                          {(["eo", "emax", "x50", "xwidth"] as const).map((p) => (
                            <tr key={p}>
                              <td className="text-muted-foreground">{p}</td>
                              <td className="metric-value text-right">
                                {DEFAULT_DEPTH_CALIBRATION[branch][p].toFixed(2)}
                              </td>
                              <td className="metric-value text-right text-signal">
                                {fit.calibration[branch][p].toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                  <div className="rounded-md border border-border/60 p-3">
                    <h3 className="text-xs font-semibold">Deep (linear) segment</h3>
                    <table className="mt-1 w-full">
                      <tbody>
                        {(["xLo", "xHi", "yLo", "yHi"] as const).map((p) => (
                          <tr key={p}>
                            <td className="text-muted-foreground">{p}</td>
                            <td className="metric-value text-right">
                              {DEFAULT_DEPTH_CALIBRATION.generalLinear[p].toFixed(2)}
                            </td>
                            <td className="metric-value text-right text-signal">
                              {fit.calibration.generalLinear[p].toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Calibration name</Label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Theatre 3 — propofol TIVA"
                      className="h-9 w-64"
                    />
                  </div>
                  <Button size="sm" onClick={() => void activateFit()}>
                    Save & apply to monitor
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setFit(null)}>
                    Discard fit
                  </Button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="panel space-y-2 px-4 py-4">
          <h2 className="text-sm font-semibold">Saved calibrations</h2>
          {(calibrations.data ?? []).length ? (
            <ul className="divide-y divide-border/50 text-xs">
              {(calibrations.data ?? []).map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    <span className="font-medium">{c.name}</span>{" "}
                    <span className="text-muted-foreground">
                      {new Date(c.created_at).toLocaleString()}
                    </span>
                    {c.is_active ? (
                      <span className="ml-2 rounded-full bg-signal/10 px-2 py-0.5 text-[10px] text-signal">
                        active
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void activateStored(c.id, c.params)}
                    >
                      Apply
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={async () => {
                        await deleteCalibration(c.id);
                        await queryClient.invalidateQueries({ queryKey: ["calibrate", "saved"] });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              None yet — the published OpenIBIS constants are in use.
            </p>
          )}
          <p className="pt-2 text-[11px] text-muted-foreground">
            A fitted index is a research tool calibrated on your own labels, not a validated
            clinical monitor. Never titrate anaesthesia on this number alone.
          </p>
        </section>
      </main>
    </div>
  );
}