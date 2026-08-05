import { useState } from "react";
import { Bluetooth, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  DEFAULT_MUSE_PRESET,
  probeMuseDevice,
  requestMuseDevice,
  type MuseCapabilities,
} from "@/lib/eeg/muse";

interface Props {
  /** Called once the clinician confirms the detected streaming configuration. */
  onConfirm: (device: BluetoothDevice, preset: string) => void;
  disabled?: boolean;
}

/**
 * Pairs with the headband, reads back its firmware and supported streaming
 * modes, and makes the clinician confirm the configuration before any case
 * data is recorded.
 */
export function MuseCapabilityPanel({ onConfirm, disabled }: Props) {
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [caps, setCaps] = useState<MuseCapabilities | null>(null);
  const [preset, setPreset] = useState(DEFAULT_MUSE_PRESET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function detect() {
    setBusy(true);
    setError(null);
    try {
      const found = device ?? (await requestMuseDevice());
      setDevice(found);
      const detected = await probeMuseDevice(found);
      setCaps(detected);
      setPreset(detected.recommendedPreset);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the headband's capabilities.");
    } finally {
      setBusy(false);
    }
  }

  if (!caps) {
    return (
      <div className="space-y-2">
        <Button
          variant="secondary"
          className="w-full"
          disabled={disabled || busy}
          onClick={() => void detect()}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Bluetooth className="size-4" />
          )}
          {busy ? "Reading headband…" : "Detect Muse 2"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Pairs with the headband and reads its firmware and supported streaming modes. Nothing is
          recorded until you confirm the configuration.
        </p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  const facts: Array<[string, string]> = [
    ["Device", caps.deviceName],
    ["Model", caps.model],
    ["Firmware", caps.firmwareVersion ?? "not reported"],
    ["Hardware", caps.hardwareVersion ?? "not reported"],
    ["Protocol", caps.protocolVersion ?? "not reported"],
    ["Battery", caps.batteryPercent == null ? "not reported" : `${caps.batteryPercent}%`],
  ];

  return (
    <div className="space-y-3 rounded-md border border-border bg-card/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Headband detected</h3>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void detect()}>
          <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} /> Re-read
        </Button>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="metric-value truncate">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Streaming configuration</Label>
        <RadioGroup value={preset} onValueChange={setPreset} className="gap-2">
          {caps.presets.map((option) => (
            <label
              key={option.code}
              htmlFor={`preset-${option.code}`}
              className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-border p-2"
            >
              <RadioGroupItem
                id={`preset-${option.code}`}
                value={option.code}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-xs font-medium">
                  {option.label}
                  {option.code === caps.recommendedPreset ? " · recommended" : ""}
                </span>
                <span className="block text-xs text-muted-foreground">{option.detail}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <p className="text-xs text-muted-foreground">
          All offered modes keep the four scalp electrodes at 256 Hz, which every metric on the
          monitor assumes.
        </p>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button
        className="w-full"
        disabled={disabled || busy || !device}
        onClick={() => device && onConfirm(device, preset)}
      >
        <Bluetooth className="size-4" /> Confirm and start streaming
      </Button>
    </div>
  );
}
