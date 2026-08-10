import type React from "react";

import { MetricTile } from "@/components/monitor/MetricTile";
import { describeCoebisModel, useCoebisModel } from "@/hooks/useCoebisModel";
import { COMPOSITE_BAND_LABEL, NOCICEPTION_BAND_LABEL } from "@/lib/eeg/composite";
import { DEPTH_STATE_LABEL, depthTone } from "@/lib/eeg/depth";
import { formatDuration } from "@/lib/eeg/format";
import type { Epoch } from "@/lib/eeg/analysis";
import type { MetricTone } from "@/components/monitor/MetricCard";
import type { DepthWindowStatus, DepthWindowPrefs } from "@/hooks/useDepthWindowAlerts";
import type { UncertaintyReport } from "@/lib/eeg/uncertainty";

export interface MetricsGridProps {
  latest: Epoch | null;
  summary: {
    maxSr: number;
    suppressionSeconds: number;
    seizureAlerts: number;
  };
  srWindowSeconds: number;
  srTone: MetricTone;
  seizureAlert: boolean;
  icuMode: boolean;
  depthWindow: { status: DepthWindowStatus; prefs: DepthWindowPrefs };
  /** Confidence intervals for the spectral, suppression and seizure tiles. */
  uncertainty?: UncertaintyReport | undefined;
}

/**
 * The dashboard numerics grid. Tile order follows the active clinical mode:
 * ICU leads with seizure/suppression, anaesthesia with depth and spectral tiles.
 */
export function MetricsGrid({
  latest,
  summary,
  srWindowSeconds,
  srTone,
  seizureAlert,
  icuMode,
  depthWindow,
  uncertainty,
}: MetricsGridProps) {
  // The active COEBIS fit, refreshed while the case runs so the tile always
  // shows the number from the latest model.
  const coebisModel = useCoebisModel();
  // Short "95 % CI a–b" suffixes appended to the tiles that carry an interval.
  const srCi = uncertainty?.suppression.interval;
  const sefCi = uncertainty?.spectral.interval;
  const seizureCi = uncertainty?.seizure.interval;
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {(() => {
        const tiles: Record<string, React.ReactNode> = {
          depth: (
            <MetricTile
              key="depth"
              info="depth"
              label="Depth index (OpenIBIS)"
              value={latest?.depth.index != null ? String(latest.depth.index) : "—"}
              hint={
                latest
                  ? latest.depth.held
                    ? `Held ${latest.depth.heldSeconds.toFixed(0)}s — ${
                        latest.depth.gateReasons[0] ?? "artefact"
                      }`
                    : DEPTH_STATE_LABEL[latest.depth.state]
                  : "OpenIBIS algorithm · ±10 units vs reference"
              }
              tone={
                depthWindow.status === "below"
                  ? "critical"
                  : depthWindow.status === "above"
                    ? "caution"
                    : latest && !latest.depth.held
                      ? depthTone(latest.depth.state)
                      : "default"
              }
              pulse={depthWindow.prefs.enabled && depthWindow.status === "below"}
              confidence={latest?.confidence.depth}
              unreliable={latest ? !latest.depthReliability.reliable : false}
              degraded={latest?.depthReliability.level === "degraded"}
              reliabilityReasons={latest?.depthReliability.reasons}
            />
          ),
          coebis: (
            <MetricTile
              key="coebis"
              info="coebis"
              label="COEBIS"
              value={latest?.depth.coebis != null ? String(latest.depth.coebis) : "—"}
              hint={
                latest?.depth.coebis != null
                  ? `OpenIBIS ${latest.depth.index ?? "—"} · ${describeCoebisModel(coebisModel)} · ${coebisFitHint(coebisModel)}`
                  : `${describeCoebisModel(coebisModel)} · ${coebisFitHint(coebisModel)}`
              }
              badge={<CoebisFitBadge model={coebisModel} compact />}
              tone={
                latest?.depth.coebis == null || latest.depth.held
                  ? "default"
                  : latest.depth.coebis < 40
                    ? "caution"
                    : latest.depth.coebis > 60
                      ? "caution"
                      : "signal"
              }
              confidence={latest?.confidence.depth}
              unreliable={latest ? !latest.depthReliability.reliable : false}
              degraded={latest?.depthReliability.level === "degraded"}
              reliabilityReasons={latest?.depthReliability.reasons}
            />
          ),
          sr: (
            <MetricTile
              key="sr"
              info="sr"
              label={`Suppression ratio (${srWindowSeconds}s)`}
              value={latest ? latest.suppressionRatio.toFixed(0) : "—"}
              unit="%"
              tone={srTone}
              hint={
                srCi
                  ? `Peak ${summary.maxSr.toFixed(0)} % · 95 % CI ${srCi.low.toFixed(0)}–${srCi.high.toFixed(0)} %`
                  : `Peak ${summary.maxSr.toFixed(0)} %`
              }
              confidence={latest?.confidence.suppression}
            />
          ),
          time: (
            <MetricTile
              key="time"
              info="suppressionTime"
              label="Suppression time"
              value={formatDuration(summary.suppressionSeconds).split(" ")[0] ?? "0"}
              unit={summary.suppressionSeconds < 60 ? "s" : "min"}
              hint={`Total ${formatDuration(summary.suppressionSeconds)}`}
              tone={summary.suppressionSeconds > 0 ? "caution" : "default"}
              confidence={latest?.confidence.suppression}
            />
          ),
          seizure: (
            <MetricTile
              key="seizure"
              info="seizure"
              label="Seizure score"
              value={latest ? latest.seizureScore.toFixed(2) : "—"}
              tone={
                seizureAlert
                  ? icuMode
                    ? "critical"
                    : "caution"
                  : latest && latest.seizureScore > 0.4 && icuMode
                    ? "caution"
                    : "default"
              }
              hint={
                (seizureCi
                  ? `95 % CI ${seizureCi.low.toFixed(2)}–${seizureCi.high.toFixed(2)} · `
                  : "") +
                (icuMode
                  ? `${summary.seizureAlerts} event(s) — high sensitivity`
                  : `${summary.seizureAlerts} event(s) — background watch`)
              }
              pulse={seizureAlert && icuMode}
              confidence={latest?.confidence.seizure}
            />
          ),
          sef: (
            <MetricTile
              key="sef"
              info="sef95"
              label="Spectral edge 95"
              value={latest ? latest.sef95.toFixed(1) : "—"}
              unit="Hz"
              hint={
                sefCi
                  ? `95 % CI ${sefCi.low.toFixed(1)}–${sefCi.high.toFixed(1)} Hz · 95 % of power below`
                  : "Frequency below which 95 % of power sits"
              }
              confidence={latest?.confidence.spectral}
            />
          ),
          amp: (
            <MetricTile
              key="amp"
              info="amplitude"
              label="Amplitude (p-p)"
              value={latest ? latest.amplitudeUv.toFixed(0) : "—"}
              unit="µV"
              hint={latest?.artifact ? "Artefact suspected" : "Peak in current epoch"}
              tone={latest?.artifact ? "caution" : "default"}
              confidence={latest?.confidence.spectral}
            />
          ),
          entropy: (
            <MetricTile
              key="entropy"
              info="entropy"
              label="Spectral entropy (state)"
              value={latest ? latest.entropy.state.toFixed(2) : "—"}
              hint={
                latest
                  ? `Response ${latest.entropy.response.toFixed(2)} · SE95 ${latest.entropy.se95.toFixed(2)} · Shannon ${latest.entropy.shannon.toFixed(2)}`
                  : "Normalised Shannon entropy of the PSD"
              }
              tone={latest && latest.entropy.state > 0.9 ? "caution" : "default"}
              confidence={latest?.confidence.spectral}
            />
          ),
          dar: (
            <MetricTile
              key="dar"
              info="deltaAlpha"
              label="Delta / alpha ratio"
              value={latest ? latest.ratios.deltaAlpha.toFixed(2) : "—"}
              hint={
                latest
                  ? `Theta/alpha ${latest.ratios.thetaAlpha.toFixed(2)} — rises with slowing`
                  : "Rises with deepening anaesthesia and encephalopathy"
              }
              confidence={latest?.confidence.spectral}
            />
          ),
          bar: (
            <MetricTile
              key="bar"
              info="betaAlpha"
              label="Beta / alpha ratio"
              value={latest ? latest.ratios.betaAlpha.toFixed(2) : "—"}
              hint="Rises with light anaesthesia and benzodiazepine beta"
              confidence={latest?.confidence.spectral}
            />
          ),
          cindex: (
            <MetricTile
              key="cindex"
              info="cIndex"
              label="Consciousness index (qCON-like)"
              value={latest?.composite.cIndex != null ? String(latest.composite.cIndex) : "—"}
              hint={
                latest
                  ? latest.composite.held
                    ? "Held — artefact"
                    : COMPOSITE_BAND_LABEL[latest.composite.cBand]
                  : "Composite of fast/slow balance, entropy and suppression"
              }
              tone={
                latest?.composite.cIndex == null || latest.composite.held
                  ? "default"
                  : latest.composite.cIndex >= 80
                    ? "caution"
                    : latest.composite.cIndex < 40
                      ? "critical"
                      : "signal"
              }
              confidence={latest?.confidence.depth}
            />
          ),
          nindex: (
            <MetricTile
              key="nindex"
              info="nIndex"
              label="Nociception index (qNOX-like)"
              value={latest?.composite.nIndex != null ? String(latest.composite.nIndex) : "—"}
              hint={
                latest
                  ? latest.composite.held
                    ? "Held — artefact"
                    : NOCICEPTION_BAND_LABEL[latest.composite.nBand]
                  : "High-frequency drive, reactivity and entropy gap"
              }
              tone={
                latest?.composite.nIndex == null || latest.composite.held
                  ? "default"
                  : latest.composite.nIndex >= 60
                    ? "caution"
                    : "signal"
              }
              confidence={latest?.confidence.depth}
            />
          ),
        };
        const order = icuMode
          ? [
              "seizure",
              "sr",
              "time",
              "depth",
              "coebis",
              "cindex",
              "sef",
              "entropy",
              "dar",
              "bar",
              "amp",
              "nindex",
            ]
          : [
              "depth",
              "coebis",
              "cindex",
              "nindex",
              "sef",
              "entropy",
              "sr",
              "time",
              "dar",
              "bar",
              "amp",
              "seizure",
            ];
        return order.map((k) => tiles[k]);
      })()}
    </section>
  );
}
