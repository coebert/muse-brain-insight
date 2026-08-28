import { useEffect, useState } from "react";
import { Bug, Download, RotateCcw, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { DSA_MAX_HZ, DSA_MIN_HZ, type Epoch } from "@/lib/eeg/analysis";
import {
  bleDiagnostics,
  blePacketInspector,
  type BleLogEntry,
  type BlePacketRecord,
} from "@/lib/eeg/ble-diagnostics";
import {
  bleDiagnosticJson,
  debugFilename,
  debugSessionJson,
  downloadDebugFile,
  epochsToCsv,
  formatBleDiagnosticText,
  packetsToCsv,
  suppressionToCsv,
} from "@/lib/eeg/debug-export";
import { replayBleDiagnostic, type BleReplayResult } from "@/lib/eeg/ble-replay";
import { checkJsonExport, debugExportMeta } from "@/lib/eeg/debug-export";
import { DecoderReadyBadge } from "@/components/monitor/DecoderReadyBadge";
import type { DiagnosticExportCheck } from "@/lib/eeg/export-schema";

export interface BleDiagnosticsPanelProps {
  epochs: Epoch[];
  deviceLabel: string;
  sampleRate: number;
}

const KIND_COLOR: Record<string, string> = {
  error: "text-destructive",
  command: "text-signal",
  packet: "text-caution",
  service: "text-foreground",
  characteristic: "text-foreground",
};

/**
 * Advanced Bluetooth diagnostics: what the browser discovered, which
 * activation frames were written, the raw bytes that came back, and a
 * timestamped view of the live notification stream — all exportable, so an
 * undocumented headband can be characterised from a phone at the bedside.
 */
export function BleDiagnosticsPanel({ epochs, deviceLabel, sampleRate }: BleDiagnosticsPanelProps) {
  const [logging, setLogging] = useState(bleDiagnostics.enabled);
  const [inspecting, setInspecting] = useState(blePacketInspector.enabled);
  const [entries, setEntries] = useState<BleLogEntry[]>([]);
  const [packets, setPackets] = useState<BlePacketRecord[]>([]);
  const [replay, setReplay] = useState<BleReplayResult | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [exportCheck, setExportCheck] = useState<{ file: string; check: DiagnosticExportCheck } | null>(null);

  useEffect(() => bleDiagnostics.subscribe(setEntries), []);
  useEffect(() => blePacketInspector.subscribe(setPackets), []);

  const meta = {
    deviceLabel,
    sampleRate,
    startedAt: null,
    dsaMinHz: DSA_MIN_HZ,
    dsaMaxHz: DSA_MAX_HZ,
  };
  const totals = bleDiagnostics.packetTotals();

  /** Every JSON export is schema-checked before it is written out. */
  const exportJson = (kind: string, contents: string) => {
    const file = debugFilename(kind, "json");
    setExportCheck({ file, check: checkJsonExport(contents) });
    void downloadDebugFile(file, contents, "application/json");
  };
  const recent = packets.slice(-25).reverse();

  return (
    <section className="rounded-lg border border-border/70 bg-card p-3">
      <header className="flex items-center gap-2">
        <Bug className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-medium">Bluetooth diagnostics</h3>
      </header>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        Records service and characteristic discovery, activation commands and raw packet bytes.
        Turn it on before pairing when a headband connects but sends no data.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border/70 px-3">
          <Label htmlFor="ble-log" className="text-xs">
            Capture connection log
          </Label>
          <Switch
            id="ble-log"
            checked={logging}
            onCheckedChange={(on) => {
              setLogging(on);
              bleDiagnostics.setEnabled(on);
            }}
          />
        </div>
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border/70 px-3">
          <Label htmlFor="ble-inspect" className="text-xs">
            Packet inspector
          </Label>
          <Switch
            id="ble-inspect"
            checked={inspecting}
            onCheckedChange={(on) => {
              setInspecting(on);
              blePacketInspector.setEnabled(on);
            }}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={!entries.length}
          onClick={() =>
            downloadDebugFile(
              debugFilename("ble-log", "txt"),
              formatBleDiagnosticText(entries, totals),
              "text/plain",
            )
          }
        >
          <Download className="size-3.5" aria-hidden /> Log (.txt)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={!entries.length}
          onClick={() =>
            exportJson("ble-log", bleDiagnosticJson(entries, totals, debugExportMeta("ble-log", meta)))
          }
        >
          <Download className="size-3.5" aria-hidden /> Log (.json)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={!packets.length}
          onClick={() =>
            downloadDebugFile(
              debugFilename("packets", "csv"),
              packetsToCsv(packets),
              "text/csv",
            )
          }
        >
          <Download className="size-3.5" aria-hidden /> Packets (.csv)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={!epochs.length}
          onClick={() =>
            downloadDebugFile(
              debugFilename("spectral-frames", "csv"),
              epochsToCsv(epochs, meta),
              "text/csv",
            )
          }
        >
          <Download className="size-3.5" aria-hidden /> Spectral frames (.csv)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={!epochs.length}
          onClick={() =>
            downloadDebugFile(
              debugFilename("suppression", "csv"),
              suppressionToCsv(epochs),
              "text/csv",
            )
          }
        >
          <Download className="size-3.5" aria-hidden /> Suppression (.csv)
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={!epochs.length && !packets.length}
          onClick={() => exportJson("debug-session", debugSessionJson(epochs, meta, packets, entries))}
        >
          <Download className="size-3.5" aria-hidden /> Everything (.json)
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="min-h-11"
          onClick={() => {
            bleDiagnostics.clear();
            blePacketInspector.clear();
          }}
        >
          <Trash2 className="size-3.5" aria-hidden /> Clear
        </Button>
        <Button asChild size="sm" variant="outline" className="min-h-11">
          <Label className="cursor-pointer">
            <Upload className="size-3.5" aria-hidden /> Replay exported log
            <input
              className="sr-only"
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setReplayError(null);
                void file
                  .text()
                  .then((text) => setReplay(replayBleDiagnostic(text)))
                  .catch((error: unknown) => {
                    setReplay(null);
                    setReplayError(error instanceof Error ? error.message : "Could not replay this file.");
                  });
              }}
            />
          </Label>
        </Button>
      </div>

      {exportCheck ? (
        <div className="mt-3">
          <DecoderReadyBadge check={exportCheck.check} label={exportCheck.file} />
        </div>
      ) : null}

      {replay || replayError ? (
        <div className="mt-3 rounded-md border border-border/70 p-3 text-xs" role="status">
          <div className="flex items-center gap-2 font-medium">
            <RotateCcw className="size-3.5 text-signal" aria-hidden /> Packet replay
          </div>
          {replayError ? <p className="mt-2 text-critical">{replayError}</p> : null}
          {replay ? (
            <div className="mt-2 space-y-2">
              <DecoderReadyBadge check={replay.check} label="imported capture" />
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                <div><dt className="text-muted-foreground">Packets</dt><dd className="metric-value">{replay.packetCount}</dd></div>
                <div><dt className="text-muted-foreground">Sources</dt><dd className="metric-value">{replay.sourceCount}</dd></div>
                <div><dt className="text-muted-foreground">Decoder</dt><dd className="metric-value">{replay.format ?? "None"}</dd></div>
                <div><dt className="text-muted-foreground">Samples</dt><dd className="metric-value">{replay.decodedSamples.toLocaleString()}</dd></div>
              </dl>
              <p className={replay.decodedSamples ? "text-signal" : "text-caution"}>
                {replay.decodedSamples
                  ? `Replay recovered ${replay.decodedSamples.toLocaleString()} samples using the live production decoder.`
                  : "Packets were reproduced, but no current decoder identified an EEG stream."}
              </p>
              {replay.candidates.length ? (
                <p className="text-muted-foreground">
                  Ranked candidates: {replay.candidates.map((candidate) => `${candidate.format} (${candidate.score.toFixed(2)})`).join(", ")}
                </p>
              ) : null}
              {replay.warnings.map((warning) => <p key={warning} className="text-caution">{warning}</p>)}
            </div>
          ) : null}
        </div>
      ) : null}

      {recent.length ? (
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Live notifications (latest {recent.length} of {blePacketInspector.totalSeen})
          </p>
          <div className="mt-1 max-h-52 overflow-auto rounded-md border border-border/70">
            <table className="w-full text-left font-mono text-[10px] tabular-nums">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr>
                  <th className="px-2 py-1">Time</th>
                  <th className="px-2 py-1">Δms</th>
                  <th className="px-2 py-1">Bytes</th>
                  <th className="px-2 py-1">Samples</th>
                  <th className="px-2 py-1">Hex</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((packet, index) => (
                  <tr key={`${packet.at}-${index}`} className="border-t border-border/50">
                    <td className="px-2 py-1">{new Date(packet.at).toISOString().slice(11, 23)}</td>
                    <td className="px-2 py-1">{packet.deltaMs}</td>
                    <td className="px-2 py-1">{packet.bytes}</td>
                    <td className="px-2 py-1">{packet.decodedSamples}</td>
                    <td className="px-2 py-1 break-all">{packet.hex}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {entries.length ? (
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Connection log ({entries.length} entries)
          </p>
          <div className="mt-1 max-h-64 overflow-auto rounded-md border border-border/70 p-2">
            {entries.slice(-120).map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="font-mono text-[10px] leading-relaxed">
                <span className="text-muted-foreground">
                  {(entry.t / 1000).toFixed(2)}s{" "}
                </span>
                <span className={KIND_COLOR[entry.kind] ?? "text-muted-foreground"}>
                  {entry.kind}
                </span>{" "}
                <span className="break-words">{entry.message}</span>
                {entry.hex ? (
                  <div className="break-all pl-6 text-caution">{entry.hex}</div>
                ) : null}
                {entry.data ? (
                  <div className="break-all pl-6 text-muted-foreground/80">
                    {JSON.stringify(entry.data)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
