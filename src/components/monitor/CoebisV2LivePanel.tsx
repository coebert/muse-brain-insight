import type { DeviceProfile } from "@/lib/eeg/device-profile";
import type { CoebisV2DeviceSetup, LiveCoebisV2Reading } from "@/lib/eeg/coebis-v2-device";
import { COEBIS_V2_MODEL } from "@/lib/eeg/coebis-v2";

/**
 * The rebuilt depth index as it reads on the band actually in use, with the
 * montage caveats stated next to the number rather than buried in a settings
 * page. The badge is deliberately blunt: on a headband this is a research
 * reading, and the published held-out error does not apply to it.
 */
export function CoebisV2LivePanel({
  reading,
  setup,
  profile,
}: {
  reading: LiveCoebisV2Reading | null;
  setup: CoebisV2DeviceSetup;
  profile: DeviceProfile;
}) {
  const badgeTone =
    setup.applicability === "fitted"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      : setup.applicability === "near"
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";

  return (
    <section className="panel p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Rebuilt depth index (COEBIS-2)</h3>
          <p className="text-xs text-muted-foreground">
            {profile.label} · {setup.channels.join(", ")} ·{" "}
            {profile.sampleRate} Hz
          </p>
        </div>
        <span className={`rounded-full px-2 py-1 text-[11px] ${badgeTone}`}>{setup.verdict}</span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Index</div>
          <div className="metric-value text-3xl tabular-nums">
            {reading ? reading.index : "—"}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Suppression (60 s)
          </div>
          <div className="metric-value text-3xl tabular-nums">
            {reading ? `${reading.suppressionRatio.toFixed(0)}%` : "—"}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Amplitude scale
          </div>
          <div className="mt-1 text-sm">
            {setup.amplitudeNormalised
              ? `Auto-matched (×${reading ? reading.gain.toFixed(2) : "…"})`
              : "Real microvolts"}
          </div>
        </div>
      </div>

      {reading && reading.drivers.length ? (
        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            What is driving this reading
          </div>
          <ul className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
            {reading.drivers.slice(0, 4).map((d) => (
              <li key={d.term} className="flex items-center justify-between gap-2">
                <span className="font-mono">{d.term}</span>
                <span className="tabular-nums text-muted-foreground">
                  {d.contribution > 0 ? "+" : ""}
                  {d.contribution.toFixed(1)} pts
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
        {setup.caveats.map((c) => (
          <li key={c}>· {c}</li>
        ))}
        <li>
          · Fitted on {COEBIS_V2_MODEL.meta.lineage}; its {COEBIS_V2_MODEL.meta.heldOutMae.toFixed(2)}
          -point held-out error belongs to that setup, not to this band.
        </li>
      </ul>
    </section>
  );
}
