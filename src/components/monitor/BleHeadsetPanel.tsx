import { useState } from "react";
import { Bluetooth, Check, ChevronDown, Loader2, Radio, RefreshCw } from "lucide-react";

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

/**
 * Pairs a non-Muse Bluetooth headset — the FocusCalm band in particular —
 * by discovering its streaming characteristic and packet layout live, then
 * hands the stream to the case as an ordinary EEG source.
 */
export function BleHeadsetPanel({ onStart, disabled }: Props) {
  const supported = isWebBluetoothAvailable();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<BleDiscovery | null>(null);
  const [progress, setProgress] = useState<BleConnectionProgress | null>(null);
  const [electrode, setElectrode] = useState<AnalysisChannel>("AF7");
  const [uvPerCount, setUvPerCount] = useState("");

  async function connect() {
    setBusy(true);
    setError(null);
    setDiscovery(null);
    setProgress(null);
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
      const started = await onStart(source, (connectionError) => {
        setError(friendlyBleError(connectionError));
      });
      if (!started) return;
    } catch (e) {
      setError(friendlyBleError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-border p-3">
      <header className="flex items-center gap-2">
        <Radio className="size-4 text-signal" aria-hidden />
        <h3 className="text-sm font-medium">FocusCalm</h3>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        Connect directly and start with the correct settings automatically.
      </p>

      {supported ? null : (
        <p className="mt-2 rounded-md border border-caution/40 bg-caution/10 p-2 text-xs text-muted-foreground">
          {WEB_BLUETOOTH_HELP}
        </p>
      )}

      <ol className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        {[
          "Unplug the charging cable",
          "Close the FocusCalm phone app",
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

      {discovery ? (
        <dl className="metric-value mt-3 grid gap-1 rounded-md border border-border p-2 text-[11px] text-muted-foreground">
          <div>
            {discovery.deviceName} · {PACKET_FORMAT_LABEL[discovery.format]} ·{" "}
            {discovery.sampleRate} Hz · {discovery.packetsPerSecond} packets/s
          </div>
          <div className="text-signal">EEG signal confirmed</div>
        </dl>
      ) : null}

      <Button
        variant={error ? "secondary" : "default"}
        size="lg"
        className="mt-3 w-full"
        disabled={disabled || busy || !supported}
        onClick={() => void connect()}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : error ? (
          <RefreshCw className="size-4" />
        ) : (
          <Bluetooth className="size-4" />
        )}
        {busy ? "Connecting…" : error ? "Try again" : "Connect FocusCalm"}
      </Button>
    </section>
  );
}
