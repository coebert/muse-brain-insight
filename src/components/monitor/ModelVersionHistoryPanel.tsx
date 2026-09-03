/**
 * COEBIS model version history.
 *
 * Every refit — promoted or not — is kept, so a reviewer can answer three
 * questions for any number the app has ever shown: what data trained it, what
 * the weights were, and what the change did to held-out error. Weights are
 * shown against the previous version of the same lineage, because a weight on
 * its own says very little.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, History, Loader2 } from "lucide-react";

import { getRefitOverview, type ModelVersionRow } from "@/lib/eeg/coebis-refit.functions";
import {
  describeWeights,
  diffWeights,
  trainingSummary,
  versionVerdict,
  type WeightDelta,
} from "@/lib/eeg/coebis-version-history";
import { cn } from "@/lib/utils";

const plain = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
const signed = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
const when = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};

const KIND_LABEL: Record<WeightDelta["kind"], string> = {
  shape: "Index shape",
  covariate: "Patient covariate",
  drug: "Drug effect site",
};

function WeightTable({ rows }: { rows: WeightDelta[] }) {
  if (!rows.length) {
    return (
      <p className="text-[11px] text-muted-foreground">
        This version carries no fitted weights — it maps the open index straight through.
      </p>
    );
  }
  const groups: WeightDelta["kind"][] = ["shape", "covariate", "drug"];
  return (
    <div className="space-y-2">
      {groups.map((kind) => {
        const inKind = rows.filter((r) => r.kind === kind);
        if (!inKind.length) return null;
        return (
          <div key={kind}>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {KIND_LABEL[kind]}
            </p>
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-0.5 text-left font-normal">Term</th>
                  <th className="py-0.5 text-right font-normal">Weight</th>
                  <th className="py-0.5 text-right font-normal">Previous</th>
                  <th className="py-0.5 text-right font-normal">Change</th>
                  <th className="py-0.5 text-right font-normal">Readings</th>
                </tr>
              </thead>
              <tbody>
                {inKind.map((r) => (
                  <tr key={r.id} className="border-t border-border/40">
                    <td className="py-0.5 pr-2">
                      {r.label}
                      {r.status === "added" ? (
                        <span className="ml-1 rounded bg-signal/15 px-1 text-signal">new</span>
                      ) : null}
                      {r.status === "removed" ? (
                        <span className="ml-1 rounded bg-muted px-1 text-muted-foreground">
                          dropped
                        </span>
                      ) : null}
                    </td>
                    <td className="py-0.5 text-right tabular-nums">{plain(r.value, 2)}</td>
                    <td className="py-0.5 text-right tabular-nums text-muted-foreground">
                      {r.previous == null ? "—" : plain(r.previous, 2)}
                    </td>
                    <td
                      className={cn(
                        "py-0.5 text-right tabular-nums",
                        r.delta ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {r.delta == null ? "—" : signed(r.delta, 2)}
                    </td>
                    <td className="py-0.5 text-right tabular-nums text-muted-foreground">
                      {r.n ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function VersionEntry({
  version,
  previous,
  defaultOpen,
}: {
  version: ModelVersionRow;
  previous: ModelVersionRow | null;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rows = useMemo(
    () =>
      diffWeights(
        describeWeights(version.modelFamily, version.coefficients),
        previous ? describeWeights(previous.modelFamily, previous.coefficients) : null,
      ),
    [version, previous],
  );

  return (
    <li className="border-t border-border/50 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 py-2 text-left"
      >
        <span className="metric-value text-xs">v{version.version}</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[11px]",
            version.isActive
              ? "bg-signal/15 text-signal"
              : version.promoted
                ? "bg-muted text-foreground"
                : "bg-muted text-muted-foreground",
          )}
        >
          {version.isActive ? "live" : version.promoted ? "superseded" : "candidate"}
        </span>
        <span className="text-[11px] text-muted-foreground">{when(version.createdAt)}</span>
        <span className="text-[11px] text-muted-foreground">
          MAE {plain(version.before.mae)} → {plain(version.after.mae)} · bias{" "}
          {signed(version.after.bias, 1)} · CCC {plain(version.after.ccc)}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="space-y-2 pb-3">
          <p className="text-[11px] text-muted-foreground">{versionVerdict(version)}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded bg-muted/40 px-2 py-1.5 text-[11px]">
              <p className="uppercase tracking-wide text-muted-foreground">Training lineage</p>
              <p className="text-foreground">{version.training.lineageKey ?? version.lineageKey}</p>
              <p className="text-muted-foreground">{trainingSummary(version.training)}</p>
              {version.training.firstReadingAt ? (
                <p className="text-muted-foreground">
                  Readings {when(version.training.firstReadingAt)} –{" "}
                  {when(version.training.lastReadingAt)}
                </p>
              ) : null}
              <p className="text-muted-foreground">
                Family {version.modelFamily} · data digest{" "}
                <code>{version.dataDigest.slice(0, 12) || "—"}</code>
              </p>
            </div>
            <div className="rounded bg-muted/40 px-2 py-1.5 text-[11px]">
              <p className="uppercase tracking-wide text-muted-foreground">Performance</p>
              <p className="text-muted-foreground">
                Before: MAE {plain(version.before.mae)} · bias {signed(version.before.bias, 1)} ·
                CCC {plain(version.before.ccc)} (
                {version.before.source === "raw_index" ? "raw index" : "previous model"})
              </p>
              <p className="text-muted-foreground">
                After (held out): MAE {plain(version.after.mae)} · bias{" "}
                {signed(version.after.bias, 1)} · CCC {plain(version.after.ccc)} on{" "}
                {version.after.n ?? 0} readings
              </p>
              <p className="text-muted-foreground">Gain {signed(version.maeGain)}</p>
              {version.reason ? <p className="text-muted-foreground">{version.reason}</p> : null}
            </div>
          </div>
          <WeightTable rows={rows} />
        </div>
      ) : null}
    </li>
  );
}

export function ModelVersionHistoryPanel() {
  const fetchOverview = useServerFn(getRefitOverview);
  const { data, isLoading, error } = useQuery({
    queryKey: ["coebis-refit-overview"],
    queryFn: () => fetchOverview(),
    staleTime: 30_000,
  });

  return (
    <section className="panel p-4">
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          COEBIS model version history
        </h2>
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Every refit is kept — promoted or not — with the acquisition lineage and window it was
        trained on, its fitted weights against the previous version, and its held-out performance.
      </p>

      {error ? <p className="mt-3 text-xs text-critical">{(error as Error).message}</p> : null}

      {data ? (
        data.lineages.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            No model versions recorded yet. The pipeline writes one the first time a lineage has
            enough validated paired readings to fit.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {data.lineages.map((l) => (
              <div key={l.lineageKey} className="rounded-md border border-border/60 px-3 pb-1 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-foreground">{l.lineageKey}</p>
                  <span className="text-[11px] text-muted-foreground">
                    {l.versions.length} version{l.versions.length === 1 ? "" : "s"} ·{" "}
                    {l.activeVersion ? `v${l.activeVersion} live` : "no promoted version"}
                  </span>
                </div>
                <ul>
                  {l.versions.map((v, i) => (
                    <VersionEntry
                      key={v.id}
                      version={v}
                      previous={l.versions[i + 1] ?? null}
                      defaultOpen={i === 0}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}
