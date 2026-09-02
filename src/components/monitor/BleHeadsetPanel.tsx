import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bluetooth,
  Check,
  ChevronDown,
  Download,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  BleHeadsetSource,
  PACKET_FORMAT_LABEL,
  describeFirmwareMatch,
  friendlyBleError,
  getLastDeviceInformation,
  getLastHandshakeProtocol,
  type BleDeviceInformation,
  type BleDiscovery,
  type BleConnectionProgress,
  type BleHandshakeProtocol,
  type BleStreamHealth,
} from "@/lib/eeg/ble-eeg";

import { StreamTestReport } from "@/components/monitor/StreamTestReport";
import {
  ANALYSIS_CHANNELS,
  ANALYSIS_SAMPLE_RATE,
  CHANNEL_REGION,
} from "@/lib/eeg/device-profile";
import { analyseStreamTest, type StreamTestResult } from "@/lib/eeg/stream-test";
import type { ChannelMap } from "@/lib/eeg/ingest";
import type { AnalysisChannel } from "@/lib/eeg/device-profile";
import { isWebBluetoothAvailable, WEB_BLUETOOTH_HELP, type EegSource } from "@/lib/eeg/muse";
import { bleDiagnostics, type BleLogEntry } from "@/lib/eeg/ble-diagnostics";
import {
  bleDiagnosticJson,
  checkJsonExport,
  debugExportMeta,
  debugFilename,
  downloadDebugFile,
} from "@/lib/eeg/debug-export";
import { DecoderReadyBadge } from "@/components/monitor/DecoderReadyBadge";
import type { DiagnosticExportCheck } from "@/lib/eeg/export-schema";
import { replayBleDiagnostic, type BleReplayResult } from "@/lib/eeg/ble-replay";

interface Props {
  /** Hands the connected headset to the case starter. */
  onStart: (source: EegSource, onConnectionError: (error: unknown) => void) => Promise<boolean>;
  disabled?: boolean;
}

const QUALITY_LABEL: Record<BleStreamHealth["quality"], string> = {
  none: "No signal",
  poor: "Poor",
  fair: "Usable",
  good: "Good",
};

/** One line of the live health read-out. */
function HealthRow({
  ok,
  pending,
  label,
  detail,
}: {
  ok: boolean;
  pending?: boolean;
  label: string;
  detail: string;
}) {
  const Icon = pending ? Loader2 : ok ? Check : X;
  return (
    <li className="flex items-start gap-2">
      <Icon
        className={`mt-0.5 size-3.5 shrink-0 ${
          pending ? "animate-spin text-muted-foreground" : ok ? "text-signal" : "text-critical"
        }`}
        aria-hidden
      />
      <span className="flex-1">
        <span className="font-medium text-foreground">{label}</span>
        <span className="block text-muted-foreground">{detail}</span>
      </span>
    </li>
  );
}

/**
 * Pairs a non-Muse Bluetooth headset — the FocusCalm band in particular — in
 * two explicit phases. First the link is opened and verified live: packets
 * decoding, stream started, sample rate delivered and signal quality. Only
 * once those checks pass can the case begin, so a case never starts on a
 * headband that pairs but never streams.
 */
/** Seconds of live stream captured by the one-tap test. */
const STREAM_TEST_SECONDS = 6;

export function BleHeadsetPanel({ onStart, disabled }: Props) {
  const supported = isWebBluetoothAvailable();
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<BleDiscovery | null>(null);
  const [progress, setProgress] = useState<BleConnectionProgress | null>(null);
  const [health, setHealth] = useState<BleStreamHealth | null>(null);
  const [electrode, setElectrode] = useState<AnalysisChannel>("AF7");
  const [uvPerCount, setUvPerCount] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<StreamTestResult | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [diagnosticEntries, setDiagnosticEntries] = useState<BleLogEntry[]>([]);
  const [replay, setReplay] = useState<BleReplayResult | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [exportCheck, setExportCheck] = useState<DiagnosticExportCheck | null>(null);
  /** Firmware/model reported by the band, and the handshake actually used. */
  const [deviceInfo, setDeviceInfo] = useState<BleDeviceInformation | null>(null);
  const [handshake, setHandshake] = useState<BleHandshakeProtocol | null>(null);

  const sourceRef = useRef<BleHeadsetSource | null>(null);
  const adoptedRef = useRef(false);

  // A verified-but-unused link must not stay open when the dialog closes.
  useEffect(
    () => () => {
      if (!adoptedRef.current) void sourceRef.current?.stop();
    },
    [],
  );
  useEffect(() => bleDiagnostics.subscribe(setDiagnosticEntries), []);

  async function connect() {
    // Failed physical-device attempts are otherwise impossible to reproduce.
    // Capture raw notifications automatically; the bounded logger contains no
    // patient or case data and can be exported directly from this panel.
    bleDiagnostics.setEnabled(true);
    setBusy(true);
    setError(null);
    setDiscovery(null);
    setProgress(null);
    setHealth(null);
    setTestResult(null);
    setDiagnostic(null);
    if (sourceRef.current && !adoptedRef.current) await sourceRef.current.stop();
    sourceRef.current = null;
    let pendingSource: BleHeadsetSource | null = null;
    try {
      const map: ChannelMap = { TP9: null, AF7: null, AF8: null, TP10: null };
      map[electrode] = "ble";
      const scale = Number(uvPerCount);
      const source = new BleHeadsetSource({
        channelMap: map,
        label: "Regul8 headband",
        onProgress: setProgress,
        // Some bands only begin streaming after their own startup or contact
        // check; a 3 s window declared those dead before they ever spoke.
        listenSeconds: 15,
        ...(Number.isFinite(scale) && scale > 0 ? { uvPerCount: scale } : {}),
      });

      pendingSource = source;
      source.onDiscovery((d) => setDiscovery(d));
      source.onHealth(setHealth);
      // Preflight: run the stream into a sink so health can be measured before
      // any patient data is recorded. The case adopts the same live stream.
      await source.start(() => {});
      sourceRef.current = source;
      pendingSource = null;
      setHealth(source.health());
    } catch (e) {
      // start() also performs defensive cleanup. Keeping this here protects
      // the UI if a future source fails after opening the radio but before it
      // can assign itself to sourceRef.
      await pendingSource?.stop();
      setError(friendlyBleError(e));
      const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setDiagnostic(`${progress?.stage ?? "starting"} · ${raw}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * One-tap proof that the headband is usable: a few seconds of the live
   * stream are captured off the same source the case will use and pushed
   * through the monitor's spectral path, so the clinician sees real packets
   * turn into a real spectral array before any patient data is recorded.
   */
  async function runStreamTest() {
    const source = sourceRef.current;
    if (!source) return;
    setTesting(true);
    setError(null);
    setTestResult(null);
    const chunks: Float64Array[] = [];
    const startPackets = source.health().totalPackets;
    const startedAt = performance.now();
    try {
      source.start((_channel, samples) => {
        chunks.push(Float64Array.from(samples));
      });
      await new Promise((r) => setTimeout(r, STREAM_TEST_SECONDS * 1000));
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const signal = new Float64Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        signal.set(chunk, offset);
        offset += chunk.length;
      }
      const captureSeconds = (performance.now() - startedAt) / 1000;
      setTestResult(
        analyseStreamTest(signal, {
          sampleRate: ANALYSIS_SAMPLE_RATE,
          expectedRate: ANALYSIS_SAMPLE_RATE,
          captureSeconds,
          packets: source.health().totalPackets - startPackets,
        }),
      );
      setHealth(source.health());
    } catch (e) {
      setError(friendlyBleError(e));
    } finally {
      // Hand the stream back to the discard sink until the case adopts it.
      sourceRef.current?.start(() => {});
      setTesting(false);
    }
  }

  async function beginCase() {
    const source = sourceRef.current;
    if (!source) return;
    setStarting(true);
    setError(null);
    try {
      adoptedRef.current = true;
      const started = await onStart(source, (connectionError) => {
        adoptedRef.current = false;
        setError(friendlyBleError(connectionError));
      });
      if (!started) adoptedRef.current = false;
    } catch (e) {
      adoptedRef.current = false;
      setError(friendlyBleError(e));
    } finally {
      setStarting(false);
    }
  }

  const connected = Boolean(sourceRef.current) && !busy;
  const ready = Boolean(health?.ready);

  return (
    <section className="rounded-lg border border-border p-3">
      <header className="flex items-center gap-2">
        <Radio className="size-4 text-signal" aria-hidden />
        <h3 className="text-sm font-medium">Bluetooth headband</h3>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        Connect, confirm the live signal, then start the case. Dropouts re-pair themselves. The
        Bluetooth list may show the band as Regul8, FocusCalm, FC-11, or a serial number.
      </p>

      {supported ? null : (
        <p className="mt-2 rounded-md border border-caution/40 bg-caution/10 p-2 text-xs text-muted-foreground">
          {WEB_BLUETOOTH_HELP}
        </p>
      )}

      <ol className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        {[
          "Unplug the charging cable",
          "Disconnect it and fully close the headband’s own phone app",
          "Hold power until the light blinks blue, then wear it",
        ].map((step) => (
          <li key={step} className="flex items-start gap-2 rounded-md bg-muted/40 p-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-signal" aria-hidden />
            {step}
          </li>
        ))}
      </ol>

      <Collapsible className="mt-3">
        <CollapsibleTrigger className="flex min-h-11 w-full items-center justify-between text-xs text-muted-foreground">
          Advanced settings
          <ChevronDown className="size-4" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-3 pb-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ble-electrode" className="text-xs">
              Map the stream onto
            </Label>
            <Select value={electrode} onValueChange={(v) => setElectrode(v as AnalysisChannel)}>
              <SelectTrigger id="ble-electrode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANALYSIS_CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c} — {CHANNEL_REGION[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              The band measures across the forehead; AF7 keeps it in the frontal montage.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ble-scale" className="text-xs">
              µV per ADC count (optional)
            </Label>
            <Input
              id="ble-scale"
              inputMode="decimal"
              placeholder="Leave blank to auto-scale"
              value={uvPerCount}
              onChange={(e) => setUvPerCount(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Without it the amplitude is auto-gained: spectral and depth measures stay valid, the
              absolute suppression µV threshold does not.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {progress && busy ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-signal/40 bg-signal/10 p-2 text-xs">
          <Loader2 className="size-4 shrink-0 animate-spin text-signal" aria-hidden />
          <span>{progress.message}</span>
        </div>
      ) : null}

      {error ? (
        <div className="mt-2 rounded-md border border-critical/40 bg-critical/10 p-3 text-xs">
          <p className="font-medium text-critical">Couldn’t connect the headband</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
          {diagnostic ? (
            <details className="mt-2 text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">Connection details</summary>
              <code className="mt-1 block break-words text-[11px]">{diagnostic}</code>
            </details>
          ) : null}
          {diagnosticEntries.length ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-3 min-h-11"
              onClick={() =>
                {
                  const contents = bleDiagnosticJson(
                    diagnosticEntries,
                    bleDiagnostics.packetTotals(),
                    debugExportMeta("ble-log"),
                    bleDiagnostics.allAcks(),
                    bleDiagnostics.captureContext(),
                  );
                  setExportCheck(checkJsonExport(contents));
                  void downloadDebugFile(
                    debugFilename("ble-failed-attempt", "json"),
                    contents,
                    "application/json",
                  );
                }
              }
            >
              <Download className="size-3.5" aria-hidden /> Download diagnostic capture
            </Button>
          ) : null}
          {exportCheck ? (
            <div className="mt-2">
              <DecoderReadyBadge check={exportCheck} label="saved capture" />
            </div>
          ) : null}
        </div>
      ) : null}

      <details className="mt-3 rounded-md border border-border/70 p-3 text-xs">
        <summary className="cursor-pointer font-medium text-foreground">Replay a diagnostic capture</summary>
        <p className="mt-2 text-muted-foreground">
          Import a previous JSON capture to rerun the current production decoder without reconnecting.
        </p>
        <Button asChild size="sm" variant="outline" className="mt-2 min-h-11">
          <Label className="cursor-pointer">
            <Upload className="size-3.5" aria-hidden /> Import diagnostic JSON
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
                  .catch((replayFailure: unknown) => {
                    setReplay(null);
                    setReplayError(
                      replayFailure instanceof Error
                        ? replayFailure.message
                        : "Could not replay this file.",
                    );
                  });
              }}
            />
          </Label>
        </Button>
        {replayError ? <p className="mt-2 text-critical">{replayError}</p> : null}
        {replay ? (
          <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-2" role="status">
            <DecoderReadyBadge check={replay.check} label="imported capture" />
            <p className="flex items-center gap-2 font-medium">
              <RotateCcw className="size-3.5 text-signal" aria-hidden />
              {replay.decodedSamples
                ? `${replay.decodedSamples.toLocaleString()} samples recovered`
                : "No EEG decoder matched"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {replay.packetCount} packets from {replay.sourceCount} source(s) · decoder: {replay.format ?? "none"}
            </p>
            {replay.candidates.length ? (
              <p className="mt-1 text-muted-foreground">
                Candidates: {replay.candidates.map((candidate) => `${candidate.format} (${candidate.score.toFixed(2)})`).join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </details>

      {connected && health ? (
        <div
          className={`mt-3 rounded-md border p-3 text-xs ${
            ready ? "border-signal/40 bg-signal/5" : "border-caution/40 bg-caution/10"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">Live connection health</p>
            {health.reconnecting ? (
              <span className="flex items-center gap-1 text-caution">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {health.reconnectAttempt > 1
                  ? `Reconnecting — attempt ${health.reconnectAttempt}${
                      health.nextRetryInMs > 1_000
                        ? `, next in ${Math.ceil(health.nextRetryInMs / 1000)}s`
                        : ""
                    }`
                  : "Reconnecting…"}
              </span>
            ) : null}
          </div>
          <ul className="metric-value mt-2 grid gap-2">
            <HealthRow
              ok={health.connected}
              label="Link up"
              detail={
                discovery
                  ? `${discovery.deviceName} · ${PACKET_FORMAT_LABEL[discovery.format]}`
                  : "Bluetooth connection to the headband"
              }
            />
            <HealthRow
              ok={health.decodedPacketsPerSecond > 0}
              label="Packets decoding"
              detail={`${health.decodedPacketsPerSecond}/s decoded of ${health.packetsPerSecond}/s received · ${health.totalPackets} total`}
            />
            <HealthRow
              ok={health.samplesPerSecond > 0 && health.msSinceLastPacket < 3_000}
              pending={health.totalSamples === 0}
              label="Stream running"
              detail={
                health.msSinceLastPacket < 3_000
                  ? `${health.totalSamples.toLocaleString()} samples so far`
                  : "No packet in the last few seconds"
              }
            />
            <HealthRow
              ok={health.rateRatio >= 0.7 && health.rateRatio <= 1.4}
              label="Sample rate"
              detail={`${Math.round(health.samplesPerSecond)} Hz delivered against ${health.expectedSampleRate} Hz measured, resampled onto the analysis grid`}
            />
            <HealthRow
              ok={health.quality === "good" || health.quality === "fair"}
              label={`Signal quality — ${QUALITY_LABEL[health.quality]}`}
              detail={`${health.amplitudeUv} µV typical. ${health.qualityReason}`}
            />
          </ul>
          {!ready ? (
            <p className="mt-2 flex items-start gap-2 text-caution">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Reseat the band and wait for the checks to pass before starting the case.
            </p>
          ) : null}
        </div>
      ) : null}

      {testResult ? <StreamTestReport result={testResult} /> : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Button
          variant={connected ? "outline" : error ? "secondary" : "default"}
          size="lg"
          className={connected ? "" : "sm:col-span-2"}
          disabled={disabled || busy || starting || !supported}
          onClick={() => void connect()}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : connected || error ? (
            <RefreshCw className="size-4" />
          ) : (
            <Bluetooth className="size-4" />
          )}
          {busy ? "Connecting…" : connected ? "Reconnect" : error ? "Try again" : "Connect headband"}
        </Button>
        {connected ? (
          <Button
            variant="secondary"
            size="lg"
            disabled={disabled || testing || starting}
            onClick={() => void runStreamTest()}
          >
            {testing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Activity className="size-4" />
            )}
            {testing ? `Testing stream… ${STREAM_TEST_SECONDS}s` : "Run stream test"}
          </Button>
        ) : null}
        {connected ? (
          <Button
            size="lg"
            className="sm:col-span-2"
            disabled={disabled || !ready || starting}
            onClick={() => void beginCase()}
          >
            {starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {starting ? "Starting…" : "Start case"}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
