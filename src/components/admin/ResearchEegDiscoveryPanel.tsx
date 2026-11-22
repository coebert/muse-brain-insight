import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import discovery from "@/lib/eeg/research-disease-discovery.json";
import arousal from "@/lib/eeg/research-arousal-summary.json";

type Benchmark = {
  auroc: number;
  auroc_interval: number[];
  positive: number;
  negative: number;
};

type Contrast = {
  target: string;
  evaluation: string;
  discovery_n: number;
  models: {
    all_standard: { internal_oof: Benchmark; external?: Benchmark };
    all_extended: { internal_oof: Benchmark; external?: Benchmark };
  };
  replication?: { features: { feature: string; replicated: boolean; effect_sd: number }[] };
};

function interval(result: Benchmark) {
  return result.auroc_interval.map((value) => value.toFixed(2)).join("–");
}

const featureNames: Record<string, string> = {
  "aperiodic_slope_proxy": "spectral slope",
  "alpha_peak_hz": "alpha peak frequency",
  "slowing_variability": "variability in slowing",
  "alpha_lateral_difference": "left–right alpha difference",
  "ordinal_entropy": "waveform ordinal entropy",
  "spectral_entropy": "spectral entropy",
};

function featureLabel(feature: string) {
  const [region = "unknown", name = ""] = feature.split(".");
  return region.replaceAll("_", " ") + " " + (featureNames[name] ?? name.replaceAll("_", " "));
}

export function ResearchEegDiscoveryPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">EEG disease-pattern research</CardTitle>
        <CardDescription>
          Retrospective resting EEG comparisons. Results describe groups of participants in the cited cohorts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {discovery.studies.map((study) => (
          <div key={study.run} className="space-y-3">
            {(study.contrasts as Contrast[]).map((contrast) => {
              const standard = contrast.models.all_standard;
              const extended = contrast.models.all_extended;
              const heldOut = extended.external;
              const technical = contrast.evaluation === "external technical check";
              const result = heldOut ?? extended.internal_oof;
              const comparator = standard.external ?? standard.internal_oof;
              const replicated = contrast.replication?.features.filter((feature) => feature.replicated);
              return (
                <section key={contrast.target} className="space-y-1 border-b pb-3">
                  <h3 className="font-medium">{contrast.target}</h3>
                  <p>
                    {heldOut
                      ? `${technical ? "External technical check" : "Independent cohort"} · ${result.positive + result.negative} participants`
                      : `Within-cohort cross-validation · ${contrast.discovery_n} participants`}
                    {" · "}AUROC {result.auroc.toFixed(2)} (95% bootstrap interval {interval(result)}),
                    standard spectral comparator {comparator.auroc.toFixed(2)}.
                  </p>
                  {technical ? (
                    <p className="text-muted-foreground">
                      Recording format was associated with diagnosis in the external cohort. This result is exploratory.
                    </p>
                  ) : replicated ? (
                    <p className="text-muted-foreground">
                      {replicated.length
                        ? "Associations replicated in the independent cohort: " + replicated.map((item) => featureLabel(item.feature)).join(", ") + "."
                        : "Zero screened associations met the independent replication threshold."}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">Independent replication pending.</p>
                  )}
                </section>
              );
            })}
            <a className="underline" href={study.run}>Research run and methods</a>
          </div>
        ))}
        <section className="space-y-1 border-t pt-4">
          <h3 className="font-medium">Sleep deprivation research</h3>
          <p>
            Southwest University eyes-open EEG · {arousal.completePairs} matched participants.
            Fitted on {arousal.fitParticipants}, tested on {arousal.testParticipants}.
            Extended multichannel AUROC {arousal.extended.toFixed(2)} (95% paired bootstrap interval{" "}
            {arousal.interval.map((value) => value.toFixed(2)).join("–")}).
            Frontal-only AUROC {arousal.frontal.toFixed(2)}.
          </p>
          <p className="text-muted-foreground">
            The previously fitted Parkinson’s research score increased after sleep deprivation
            in {arousal.scoreIncreased} of {arousal.completePairs} healthy participants. This research
            used sleep-deprivation labels and assessed score sensitivity to a non-disease state change.
          </p>
          <div className="flex flex-wrap gap-x-3">
            <a className="underline" href={arousal.dataset}>Southwest University data</a>
            <a className="underline" href={arousal.run}>Research run and methods</a>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
