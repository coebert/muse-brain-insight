import { Check, Cpu, TriangleAlert } from "lucide-react";

import type { DeviceProfile } from "@/lib/eeg/device-profile";
import type { DeviceTuning } from "@/lib/eeg/device-tuning";

/**
 * States, in one place, how the app has adapted to the connected headset:
 * what it has switched on because the device supports it, and what it has
 * held back or qualified because the device cannot support it.
 */
export function DeviceOptimisationPanel({
  profile,
  tuning,
}: {
  profile: DeviceProfile;
  tuning: DeviceTuning;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-3 sm:p-4">
      <header className="flex flex-wrap items-center gap-2">
        <Cpu className="size-4 text-signal" aria-hidden />
        <h3 className="text-sm font-semibold">Device optimisation</h3>
        <span className="metric-value text-xs text-muted-foreground">
          {tuning.label} · {profile.channels.length} ch · {profile.sampleRate} Hz
        </span>
      </header>
      <p className="mt-1 text-xs text-muted-foreground">
        Tuned automatically from the montage that is actually streaming — no manual switch is
        needed when you change headsets mid-list.
      </p>

      <dl className="metric-value mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <Fact label="DSA layout" value={tuning.defaultDsaView} />
        <Fact label="Usable band" value={`to ${tuning.usableCeilingHz} Hz`} />
        <Fact label="Amplitude" value={tuning.absoluteAmplitude ? "µV calibrated" : "auto-gained"} />
        <Fact label="Reconnect" value={tuning.autoReconnect ? "automatic" : "manual"} />
      </dl>

      <ul className="mt-3 space-y-1.5">
        {tuning.optimisations.map((o) => (
          <li key={o} className="flex gap-2 text-xs text-muted-foreground">
            <Check className="mt-0.5 size-3.5 shrink-0 text-signal" aria-hidden />
            <span>{o}</span>
          </li>
        ))}
      </ul>

      {tuning.caveats.length ? (
        <ul className="mt-3 space-y-1.5 rounded-md border border-caution/40 bg-caution/10 p-2">
          {tuning.caveats.map((c) => (
            <li key={c} className="flex gap-2 text-xs text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm capitalize">{value}</dd>
    </div>
  );
}
