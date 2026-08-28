import { useState } from "react";
import { Bluetooth, Loader2, Radio } from "lucide-react";

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
import {
  BleHeadsetSource,
  PACKET_FORMAT_LABEL,
  type BleDiscovery,
} from "@/lib/eeg/ble-eeg";
import { ANALYSIS_CHANNELS, CHANNEL_REGION } from "@/lib/eeg/device-profile";
import type { ChannelMap } from "@/lib/eeg/ingest";
import type { AnalysisChannel } from "@/lib/eeg/device-profile";
import { isWebBluetoothAvailable, WEB_BLUETOOTH_HELP, type EegSource } from "@/lib/eeg/muse";

interface Props {
  /** Hands the connected headset to the case starter. */
  onStart: (source: EegSource) => void;
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
  const [electrode, setElectrode] = useState<AnalysisChannel>("AF7");
  const [uvPerCount, setUvPerCount] = useState("");

  async function connect() {
    setBusy(true);
    setError(null);
    setDiscovery(null);
    try {
      const map: ChannelMap = { TP9: null, AF7: null, AF8: null, TP10: null };
      map[electrode] = "ble";
      const scale = Number(uvPerCount);
      const source = new BleHeadsetSource({
        channelMap: map,
        ...(Number.isFinite(scale) && scale > 0 ? { uvPerCount: scale } : {}),
      });
      source.onDiscovery((d) => setDiscovery(d));
      onStart(source);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the headset.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-border p-3">
      <header className="flex items-center gap-2">
        <Radio className="size-4 text-signal" aria-hidden />
        <h3 className="text-sm font-medium">FocusCalm / other Bluetooth headset</h3>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        Pairs a single-channel consumer band. The app subscribes to every stream the headset
        exposes, keeps the one that decodes as EEG, and measures the sample rate from the link
        itself — no vendor app or bridge needed. Close the FocusCalm phone app first: the band only
        allows one connection.
      </p>

      {supported ? null : (
        <p className="mt-2 rounded-md border border-caution/40 bg-caution/10 p-2 text-xs text-muted-foreground">
          {WEB_BLUETOOTH_HELP}
        </p>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
      </div>

      {error ? <p className="mt-2 text-xs text-critical">{error}</p> : null}

      {discovery ? (
        <dl className="metric-value mt-3 grid gap-1 rounded-md border border-border p-2 text-[11px] text-muted-foreground">
          <div>
            {discovery.deviceName} · {PACKET_FORMAT_LABEL[discovery.format]} ·{" "}
            {discovery.sampleRate} Hz · {discovery.packetsPerSecond} packets/s
          </div>
          <div className="truncate">characteristic {discovery.characteristicUuid}</div>
          {discovery.notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </dl>
      ) : null}

      <Button
        className="mt-3"
        variant="outline"
        disabled={disabled || busy || !supported}
        onClick={() => void connect()}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Bluetooth className="size-4" />}
        Connect headset and start
      </Button>
    </section>
  );
}
