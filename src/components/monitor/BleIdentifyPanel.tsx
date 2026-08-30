import { useState } from "react";
import { CheckCircle2, Download, Radar, XCircle, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  describeAck,
  formatIdentifyReport,
  identifyBleHeadset,
  type BleFirmwareAck,
  type BleIdentifyReport,
} from "@/lib/eeg/ble-identify";
import {
  runActivationCheck,
  type ActivationCheckResult,
} from "@/lib/eeg/ble-activation-check";
import { debugFilename, downloadDebugFile } from "@/lib/eeg/debug-export";
import { friendlyBleError } from "@/lib/eeg/ble-eeg";
import { StreamTestReport } from "@/components/monitor/StreamTestReport";

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
  const [check, setCheck] = useState<ActivationCheckResult | null>(null);
  const [acks, setAcks] = useState<BleFirmwareAck[]>([]);
  const [error, setError] = useState<string | null>(null);

  function beginRun() {
    setBusy(true);
    setError(null);
    setReport(null);
    setCheck(null);
    setAcks([]);
    setProgress("Starting");
  }

  /**
   * Firmware replies are pushed to the UI as they are decoded, so a rejected
   * pairing shows its code during the run rather than only in the final report.
   */
  function recordAck(ack: BleFirmwareAck) {
    setAcks((current) => [...current.slice(-40), ack]);
  }

  async function runCheck() {
    beginRun();
    try {
      const result = await runActivationCheck({
        onProgress: setProgress,
        onAck: recordAck,
      });
      setCheck(result);
      setReport(result.report);
    } catch (e) {
      setError(friendlyBleError(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function run() {
    beginRun();
    try {
      const result = await identifyBleHeadset({
        watchSeconds,
        probeActivation: probe,
        onProgress: setProgress,
        onAck: recordAck,
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
        <Button
          type="button"
          variant="secondary"
          onClick={runCheck}
          disabled={busy}
          className="min-h-10"
        >
          <Zap className="mr-1 h-4 w-4" aria-hidden /> Activation check (60s)
        </Button>
      </div>
      {probe ? (
        <p className="mt-2 text-xs text-caution">
          The probe writes documented activation commands to the band. Run it with the headband off
          a patient.
        </p>
      ) : null}

      <p className="mt-2 text-xs text-muted-foreground">
        The activation check runs the survey, sends every documented pairing/AFE/START sequence
        variant and confirms whether notifications start within 60 seconds.
      </p>

      {acks.length ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2">
          <p className="text-xs font-semibold">Firmware replies (live)</p>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
            {acks.map((ack, index) => (
              <li
                key={`${ack.atMs}-${index}`}
                className={ack.ok ? "text-signal" : "text-destructive"}
              >
                +{(ack.atMs / 1000).toFixed(1)}s {ack.ok ? "OK" : "ERR"} {describeAck(ack)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {check ? (
        <div className="mt-3 rounded-lg border border-border p-2 text-xs">
          <p
            className={`flex items-center gap-1 font-semibold ${check.passed ? "text-signal" : "text-caution"}`}
          >
            {check.passed ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden />
            ) : (
              <XCircle className="h-4 w-4" aria-hidden />
            )}
            {check.passed ? "Activation check passed" : "Activation check failed"}
          </p>
          <p className="mt-1 text-muted-foreground">{check.summary}</p>
          <p className="mt-1">{check.advice}</p>
          {check.activatedByVariant ? (
            <p className="mt-1">
              <span className="text-muted-foreground">Working sequence: </span>
              {check.activatedByVariant}
            </p>
          ) : null}
          {check.timeToFirstPacketSeconds != null ? (
            <p>
              <span className="text-muted-foreground">First notification: </span>
              {check.timeToFirstPacketSeconds}s of {check.deadlineSeconds}s
            </p>
          ) : null}
        </div>
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

          {report.sampleRate ? (
            <div className="rounded-lg bg-muted/40 p-2">
              <p className="font-semibold">
                Sample rate{" "}
                <span className={report.sampleRate.agrees ? "text-signal" : "text-caution"}>
                  {report.sampleRate.usedHz} Hz
                </span>
              </p>
              <p className="text-muted-foreground">{report.sampleRate.detail}</p>
            </div>
          ) : null}

          {report.preview ? (
            <div>
              <p className="font-semibold">
                Spectral array preview
                {report.previewCharacteristic
                  ? ` — ${report.previewCharacteristic.slice(0, 8)}`
                  : ""}
              </p>
              <StreamTestReport result={report.preview} />
            </div>
          ) : null}

          {report.probe.length ? (
            <div className="space-y-1">
              <p className="font-semibold">Activation probe</p>
              {report.activatedByVariant ? (
                <p className="text-signal">
                  Streaming started with: {report.activatedByVariant}
                </p>
              ) : null}
              {report.probe.map((step) => (
                <div key={step.name}>
                  <p className="text-muted-foreground">
                    [{step.variant}] {step.name}:{" "}
                    {step.written
                      ? `${step.packetsAfter} packet(s) back`
                      : `write failed — ${step.writeError}`}
                  </p>
                  {step.acks.map((ack, index) => (
                    <p
                      key={index}
                      className={`pl-3 font-mono ${ack.ok ? "text-signal" : "text-destructive"}`}
                    >
                      {describeAck(ack)}
                    </p>
                  ))}
                </div>
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
