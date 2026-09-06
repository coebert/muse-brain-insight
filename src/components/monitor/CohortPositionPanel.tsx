import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Users } from "lucide-react";

import { depthExposureOf } from "@/lib/eeg/case-outcomes";
import { getOutcomeCohort } from "@/lib/eeg/case-outcomes.functions";
import { cohortPosition, type ExposureBand } from "@/lib/eeg/cohort-position";
import { cn } from "@/lib/utils";

export interface CohortEpoch {
  t: number;
  suppressionRatio: number;
  depth?: { index: number | null } | null;
}

const BAND_TONE: Record<ExposureBand, string> = {
  typical: "text-signal",
  above: "text-caution",
  "well-above": "text-critical",
};

const BAND_LABEL: Record<ExposureBand, string> = {
  typical: "In line with the cohort",
  above: "Above the cohort",
  "well-above": "Well above the cohort",
};

function Row({
  label,
  minutes,
  percentile,
  median,
  icuMean,
  noIcuMean,
}: {
  label: string;
  minutes: number;
  percentile: number | null;
  median: number | null;
  icuMean: number | null;
  noIcuMean: number | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <p className="instrument-label">{label}</p>
      <p className="metric-value mt-0.5 text-2xl tabular-nums">
        {minutes.toFixed(1)}
        <span className="ml-1 text-sm text-muted-foreground">min</span>
      </p>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={
          percentile == null
            ? "No cohort comparison available"
            : `Above ${percentile}% of cohort recordings`
        }
      >
        <div
          className="h-full rounded-full bg-signal"
          style={{ width: `${percentile ?? 0}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {percentile == null
          ? "No cohort comparison"
          : `Above ${percentile}% of cohort recordings · cohort middle ${median?.toFixed(1) ?? "—"} min`}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Needed intensive care: {icuMean?.toFixed(1) ?? "—"} min · did not:{" "}
        {noIcuMean?.toFixed(1) ?? "—"} min
      </p>
    </div>
  );
}

/**
 * How the running case's depth and suppression compare with recordings whose
 * clinical outcome is known. It is a position in a distribution, never a
 * prediction: the cohort is not adjusted for how sick or how large the case
 * was, and that caveat stays on screen.
 */
export function CohortPositionPanel({ epochs }: { epochs: CohortEpoch[] }) {
  const fetchCohort = useServerFn(getOutcomeCohort);
  const cohort = useQuery({
    queryKey: ["outcome-cohort", "bedside"],
    queryFn: () => fetchCohort(),
    staleTime: 30 * 60 * 1000,
    retry: false,
  });

  const exposure = useMemo(() => {
    const readings = epochs
      .filter((e) => e.depth?.index != null)
      .map((e) => ({
        atSeconds: e.t,
        index: e.depth!.index as number,
        suppressionRatio: e.suppressionRatio,
      }));
    return depthExposureOf("live", readings);
  }, [epochs]);

  const position = useMemo(
    () => (cohort.data ? cohortPosition(exposure, cohort.data.cases) : null),
    [cohort.data, exposure],
  );

  if (cohort.isLoading)
    return (
      <section className="rounded-lg border border-border bg-card/40 p-3 text-sm text-muted-foreground">
        Loading the outcome cohort…
      </section>
    );

  if (!position)
    return (
      <section className="rounded-lg border border-border bg-card/40 p-3 text-sm text-muted-foreground">
        No outcome cohort loaded yet, so this case has nothing to be compared with. Fetch the
        recordings with known outcomes on the outcome cohort page first.
      </section>
    );

  return (
    <section className="rounded-lg border border-border bg-card/60 p-3">
      <header className="flex flex-wrap items-baseline gap-2">
        <Users className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">Compared with recordings that have known outcomes</h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {position.cohortCases} recordings · {position.icuCases} needed intensive care
        </span>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <div>
          <p className="instrument-label">Exposure position</p>
          <p
            className={cn(
              "metric-value text-4xl tabular-nums",
              BAND_TONE[position.band],
            )}
          >
            {position.score ?? "—"}
            <span className="ml-1 text-base text-muted-foreground">/100</span>
          </p>
        </div>
        <div className="min-w-[14rem] flex-1">
          <p className={cn("text-sm font-medium", BAND_TONE[position.band])}>
            {BAND_LABEL[position.band]}
          </p>
          <p className="text-xs text-muted-foreground">{position.headline}</p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Row
          label="Time below 40"
          minutes={position.below40.minutes}
          percentile={position.below40.percentile}
          median={position.below40.cohortMedian}
          icuMean={position.below40.icuMean}
          noIcuMean={position.below40.noIcuMean}
        />
        <Row
          label="Time suppressed"
          minutes={position.suppressed.minutes}
          percentile={position.suppressed.percentile}
          median={position.suppressed.cohortMedian}
          icuMean={position.suppressed.icuMean}
          noIcuMean={position.suppressed.noIcuMean}
        />
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        This is where the case sits among past recordings, not a prediction. The cohort is not
        adjusted for how sick or how large a case was, so deeper anaesthesia in it may be a marker
        of the patient rather than a cause of anything.
        {position.readable
          ? ""
          : " Too few recordings on one side of the intensive-care split for that comparison to be read into."}
      </p>
    </section>
  );
}
