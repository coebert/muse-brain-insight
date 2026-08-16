import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Gauge, Minus, Plus, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatClock } from "@/lib/eeg/format";
import { CoebisGapHint } from "@/components/monitor/CoebisGapHint";
import { BIS_DEVICES, bisBandLabel, clampBis, type BisReading } from "@/lib/eeg/bis";
import { evaluateCapturePrompt } from "@/lib/eeg/capture-prompts";
import { cn } from "@/lib/utils";

/**
 * Contemporaneous transcription of a commercial BIS monitor running alongside
 * the Muse 2. Each reading is timestamped against the case clock so the app's
 * own depth index and suppression ratio can be compared against it, and so the
 * AI can use the paired values to finesse the open model.
 */
export function BisPanel({
  readings,
  onChange,
  running,
  elapsed,
  depthIndex,
  suppressionRatio,
  sef95,
  trend = [],
  onMark,
}: {
  readings: BisReading[];
  onChange: (next: BisReading[]) => void;
  running: boolean;
  elapsed: number;
  depthIndex: number | null;
  suppressionRatio: number | null;
  sef95?: number | null;
  /** Recent depth samples so the panel can spot high-value capture moments. */
  trend?: { t: number; index: number | null }[];
  onMark: (detail: string) => void;
}) {
  const [device, setDevice] = useState<string>(BIS_DEVICES[0]);
  const [bis, setBis] = useState<number>(50);
  const [sr, setSr] = useState<string>("");
  const [sef, setSef] = useState<string>("");
  const [emg, setEmg] = useState<string>("");
  const [sqi, setSqi] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [dismissed, setDismissed] = useState<string | null>(null);

  /**
   * A reading logged at induction, in suppression or mid-swing is worth
   * several taken at steady state, so the panel asks for one at those moments
   * rather than leaving it to memory.
   */
  const lastReadingAt = readings.length ? Math.max(...readings.map((r) => r.at)) : null;
  const prompt = useMemo(
    () =>
      evaluateCapturePrompt({
        running,
        elapsed,
        depthIndex,
        suppressionRatio,
        trend,
        lastReadingAt,
        readings: readings.length,
      }),
    [running, elapsed, depthIndex, suppressionRatio, trend, lastReadingAt, readings.length],
  );
  const showPrompt = prompt && dismissed !== prompt.kind;

  const parsed = (v: string): number | null => {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function commit(next: BisReading[], message: string) {
    const before = readings;
    onChange(next);
    toast.success(message, {
      duration: 10000,
      action: { label: "Undo", onClick: () => onChange(before) },
    });
  }

  function log() {
    if (!running) {
      toast.error("Start a case before logging BIS readings.");
      return;
    }
    const value = clampBis(bis);
    const reading: BisReading = {
      id: `bis-${Date.now()}`,
      at: elapsed,
      bis: value,
      sr: parsed(sr),
      sef: parsed(sef),
      emg: parsed(emg),
      sqi: parsed(sqi),
      device,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    commit([...readings, reading].sort((a, b) => a.at - b.at), `BIS ${value} logged`);
    const delta = depthIndex == null ? "" : ` (app ${depthIndex.toFixed(0)})`;
    onMark(
      `BIS reference — ${device}: BIS ${value}${reading.sr != null ? `, SR ${reading.sr} %` : ""}${reading.sef != null ? `, SEF ${reading.sef} Hz` : ""}${delta}`,
    );
    setSr("");
    setSef("");
    setEmg("");
    setSqi("");
    setNote("");
    setDismissed(null);
  }

  const difference = depthIndex == null ? null : Math.round(depthIndex - clampBis(bis));

  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <Gauge className="size-3.5" /> Commercial BIS reference
        </span>
        <Select value={device} onValueChange={setDevice}>
          <SelectTrigger className="ml-auto h-9 w-full text-xs sm:w-[15rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BIS_DEVICES.map((d) => (
              <SelectItem key={d} value={d} className="text-xs">
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-3 rounded-lg border border-border p-3">
        {showPrompt ? (
          <div className="mb-3 flex flex-wrap items-start gap-2 rounded-md border border-signal/40 bg-signal/10 p-2">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-signal" />
            <div className="min-w-[12rem] flex-1">
              <p className="text-xs font-semibold">{prompt.title}</p>
              <p className="text-[11px] text-muted-foreground">{prompt.why}</p>
            </div>
            <Button
              size="sm"
              className="h-9"
              onClick={log}
              aria-label={`Capture BIS ${clampBis(bis)} now`}
            >
              Capture {clampBis(bis)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-9"
              onClick={() => setDismissed(prompt.kind)}
            >
              Not now
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="secondary"
            aria-label="Decrease BIS"
            className="size-11"
            onClick={() => setBis((v) => clampBis(v - 1))}
          >
            <Minus className="size-4" />
          </Button>
          <div className="flex-1 text-center">
            <span className="metric-value text-4xl leading-none">{clampBis(bis)}</span>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {bisBandLabel(clampBis(bis))}
              {difference != null ? (
                <>
                  {" · "}
                  <span
                    className={cn(
                      Math.abs(difference) > 10 ? "text-caution" : "text-muted-foreground",
                    )}
                  >
                    app {depthIndex?.toFixed(0)} ({difference > 0 ? "+" : ""}
                    {difference})
                  </span>
                </>
              ) : (
                " · app index not yet available"
              )}
            </p>
          </div>
          <Button
            size="icon"
            variant="secondary"
            aria-label="Increase BIS"
            className="size-11"
            onClick={() => setBis((v) => clampBis(v + 1))}
          >
            <Plus className="size-4" />
          </Button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <label className="text-[11px] text-muted-foreground">
            BIS value
            <Input
              type="number"
              inputMode="numeric"
              value={bis}
              onChange={(e) => setBis(Number(e.target.value))}
              className="mt-1 h-10"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            SR %{suppressionRatio != null ? ` (app ${suppressionRatio.toFixed(0)})` : ""}
            <Input
              type="number"
              inputMode="decimal"
              value={sr}
              placeholder="—"
              onChange={(e) => setSr(e.target.value)}
              className="mt-1 h-10"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            SEF Hz{sef95 != null ? ` (app ${sef95.toFixed(1)})` : ""}
            <Input
              type="number"
              inputMode="decimal"
              step="0.1"
              value={sef}
              placeholder="—"
              onChange={(e) => setSef(e.target.value)}
              className="mt-1 h-10"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            EMG dB
            <Input
              type="number"
              inputMode="decimal"
              value={emg}
              placeholder="—"
              onChange={(e) => setEmg(e.target.value)}
              className="mt-1 h-10"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            SQI %
            <Input
              type="number"
              inputMode="numeric"
              value={sqi}
              placeholder="—"
              onChange={(e) => setSqi(e.target.value)}
              className="mt-1 h-10"
            />
          </label>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            value={note}
            placeholder="Note (e.g. after propofol bolus, diathermy running)"
            onChange={(e) => setNote(e.target.value)}
            className="h-10 flex-1 text-xs"
          />
          <Button className="h-10" disabled={!running} onClick={log}>
            Log at {formatClock(elapsed)}
          </Button>
        </div>
      </div>

      <CoebisGapHint className="mt-3" />

      {readings.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          No reference readings yet. Log the commercial monitor's value whenever it is worth
          comparing — at induction, after each target change, and at any divergence.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {[...readings]
            .reverse()
            .slice(0, 12)
            .map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs"
              >
                <span className="metric-value opacity-80">{formatClock(r.at)}</span>
                <span className="font-semibold">BIS {r.bis}</span>
                {r.sr != null ? (
                  <span className="text-muted-foreground">SR {r.sr} %</span>
                ) : null}
                {r.sef != null ? (
                  <span className="text-muted-foreground">SEF {r.sef} Hz</span>
                ) : null}
                {r.emg != null ? (
                  <span className="text-muted-foreground">EMG {r.emg} dB</span>
                ) : null}
                {r.sqi != null ? (
                  <span className="text-muted-foreground">SQI {r.sqi} %</span>
                ) : null}
                {r.note ? <span className="truncate text-muted-foreground">{r.note}</span> : null}
                <button
                  type="button"
                  aria-label={`Remove BIS reading at ${formatClock(r.at)}`}
                  className="ml-auto opacity-70 hover:opacity-100"
                  onClick={() =>
                    commit(
                      readings.filter((x) => x.id !== r.id),
                      "Reading removed",
                    )
                  }
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
