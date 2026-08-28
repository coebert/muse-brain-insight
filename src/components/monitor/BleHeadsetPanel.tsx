import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Bluetooth,
  Check,
  ChevronDown,
  Loader2,
  Play,
  Radio,
  RefreshCw,
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
  friendlyBleError,
  type BleDiscovery,
  type BleConnectionProgress,
  type BleStreamHealth,
} from "@/lib/eeg/ble-eeg";
import { ANALYSIS_CHANNELS, CHANNEL_REGION } from "@/lib/eeg/device-profile";
import type { ChannelMap } from "@/lib/eeg/ingest";
import type { AnalysisChannel } from "@/lib/eeg/device-profile";
import { isWebBluetoothAvailable, WEB_BLUETOOTH_HELP, type EegSource } from "@/lib/eeg/muse";

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
  const sourceRef = useRef<BleHeadsetSource | null>(null);
  const adoptedRef = useRef(false);

  // A verified-but-unused link must not stay open when the dialog closes.
  useEffect(
    () => () => {
      if (!adoptedRef.current) void sourceRef.current?.stop();
    },
    [],
  );

  async function connect() {
    setBusy(true);
    setError(null);
    setDiscovery(null);
    setProgress(null);
    setHealth(null);
    if (sourceRef.current && !adoptedRef.current) await sourceRef.current.stop();
    try {
      const map: ChannelMap = { TP9: null, AF7: null, AF8: null, TP10: null };
      map[electrode] = "ble";
      const scale = Number(uvPerCount);
      const source = new BleHeadsetSource({
        channelMap: map,
        label: "FocusCalm",
        onProgress: setProgress,
        ...(Number.isFinite(scale) && scale > 0 ? { uvPerCount: scale } : {}),
      });
      source.onDiscovery((d) => setDiscovery(d));
      source.onHealth(setHealth);
      // Preflight: run the stream into a sink so health can be measured before
      // any patient data is recorded. The case adopts the same live stream.
      await source.start(() => {});
      sourceRef.current = source;
      setHealth(source.health());
    } catch (e) {
      setError(friendlyBleError(e));
    } finally {
      setBusy(false);
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
        <h3 className="text-sm font-medium">FocusCalm</h3>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        Connect, confirm the live signal, then start the case. Dropouts re-pair themselves. The
        Bluetooth list may show the band as FocusCalm, FC-11, or a serial number.
      </p>

      {supported ? null : (
        <p className="mt-2 rounded-md border border-caution/40 bg-caution/10 p-2 text-xs text-muted-foreground">
          {WEB_BLUETOOTH_HELP}
        </p>
      )}

      <ol className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        {[
          "Unplug the charging cable",
          "Disconnect it and fully close the FocusCalm phone app",
          "Switch the band on and wear it",
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
              FocusCalm measures across the forehead; AF7 keeps it in the frontal montage.
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
          <p className="font-medium text-critical">Couldn’t connect FocusCalm</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
        </div>
      ) : null}

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
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Reconnecting…
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
          {busy ? "Connecting…" : connected ? "Reconnect" : error ? "Try again" : "Connect FocusCalm"}
        </Button>
        {connected ? (
          <Button
            size="lg"
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
