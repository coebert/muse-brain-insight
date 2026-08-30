import { useState } from "react";
import { Download, Radar } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  formatIdentifyReport,
  identifyBleHeadset,
  type BleIdentifyReport,
} from "@/lib/eeg/ble-identify";
import { debugFilename, downloadDebugFile } from "@/lib/eeg/debug-export";
import { friendlyBleError } from "@/lib/eeg/ble-eeg";

const WATCH_CHOICES = [15, 30, 60];

const STATUS_TEXT: Record<BleIdentifyReport["status"], string> = {
  eeg: "EEG found",
  traffic: "Data seen, not decoded",
  silent: "Connected but silent",
  "no-notify": "No streaming channels",
  "no-services": "Nothing exposed",
};

const STATUS_CLASS: Record<BleIdentifyReport["status"], string> = {
  eeg: "text-signal",
  traffic: "text-caution",
  silent: "text-caution",
  "no-notify": "text-destructive",
  "no-services": "text-destructive",
};

/**
 * Non-destructive headband survey. It never starts a case and never aborts on
 * "no EEG decoded": it always finishes with a report of what the band exposes
 * and what it sent, so an undocumented device can be characterised at the
 * bedside and the evidence exported in one tap.
 */
export function BleIdentifyPanel() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [watchSeconds, setWatchSeconds] = useState(30);
  const [probe, setProbe] = useState(false);
  const [report, setReport] = useState<BleIdentifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setReport(null);
    setProgress("Starting");
    try {
      const result = await identifyBleHeadset({
        watchSeconds,
        probeActivation: probe,
        onProgress: setProgress,
      });
      setReport(result);
    } catch (e) {
      setError(friendlyBleError(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  function exportText() {
    if (!report) return;
    void downloadDebugFile(
      debugFilename("headband-survey", "txt"),
      formatIdentifyReport(report),
      "text/plain",
    );
  }

  function exportJson() {
    if (!report) return;
    void downloadDebugFile(
      debugFilename("headband-survey", "json"),
      JSON.stringify(report, null, 2),
      "application/json",
    );
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="flex items-center gap-2">
        <Radar className="h-4 w-4 text-signal" aria-hidden />
        <h3 className="text-sm font-semibold">Identify headband</h3>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        Connects to a headband and reports exactly what it exposes and what it transmits, without
        starting a case. Use this when a band connects but no EEG appears.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Watch for</span>
          {WATCH_CHOICES.map((seconds) => (
            <Button
              key={seconds}
              type="button"
              size="sm"
              variant={watchSeconds === seconds ? "default" : "outline"}
              className="min-h-9 px-3"
              onClick={() => setWatchSeconds(seconds)}
              disabled={busy}
            >
              {seconds}s
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="identify-probe"
            checked={probe}
            onCheckedChange={setProbe}
            disabled={busy}
          />
          <Label htmlFor="identify-probe" className="text-xs">
            Advanced: activation probe
          </Label>
        </div>
        <Button type="button" onClick={run} disabled={busy} className="min-h-10">
          {busy ? (progress ?? "Surveying…") : "Run survey"}
        </Button>
      </div>
      {probe ? (
        <p className="mt-2 text-xs text-caution">
          The probe writes documented activation commands to the band. Run it with the headband off
          a patient.
        </p>
      ) : null}

      {error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}

      {report ? (
        <div className="mt-4 space-y-3 text-xs">
          <div>
            <p className={`font-semibold ${STATUS_CLASS[report.status]}`}>
              {STATUS_TEXT[report.status]} — {report.deviceName}
            </p>
            <p className="text-muted-foreground">{report.summary}</p>
            <p className="mt-1">{report.advice}</p>
          </div>

          {Object.keys(report.information).length || report.batteryPercent != null ? (
            <div className="rounded-lg bg-muted/40 p-2">
              {Object.entries(report.information).map(([key, value]) => (
                <p key={key}>
                  <span className="text-muted-foreground">{key}: </span>
                  {value}
                </p>
              ))}
              {report.batteryPercent != null ? (
                <p>
                  <span className="text-muted-foreground">Battery: </span>
                  {report.batteryPercent}%
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-medium">Channel</th>
                  <th className="py-1 pr-2 font-medium">Properties</th>
                  <th className="py-1 pr-2 font-medium">Packets</th>
                  <th className="py-1 font-medium">Best layout</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {report.characteristics.map((entry) => (
                  <tr key={`${entry.serviceUuid}/${entry.characteristicUuid}`} className="border-t border-border/60">
                    <td className="py-1 pr-2">{entry.characteristicUuid.slice(0, 8)}</td>
                    <td className="py-1 pr-2">{entry.properties.join(",") || "—"}</td>
                    <td className="py-1 pr-2">
                      {entry.subscriptionError
                        ? "subscribe failed"
                        : `${entry.packets} (${entry.packetsPerSecond}/s)`}
                    </td>
                    <td className="py-1">
                      {entry.bestFormatLabel
                        ? `${entry.bestFormatLabel} ${entry.bestScore ?? ""}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.probe.length ? (
            <div className="space-y-1">
              <p className="font-semibold">Activation probe</p>
              {report.probe.map((step) => (
                <p key={step.name} className="text-muted-foreground">
                  {step.name}:{" "}
                  {step.written
                    ? `${step.packetsAfter} packet(s) back`
                    : `write failed — ${step.writeError}`}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={exportText}>
              <Download className="mr-1 h-3.5 w-3.5" aria-hidden /> Export report
            </Button>
            <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={exportJson}>
              <Download className="mr-1 h-3.5 w-3.5" aria-hidden /> Export JSON
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
