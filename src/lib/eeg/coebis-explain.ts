/**
 * Phase 5 — model explainability.
 *
 * A number the clinician cannot interrogate is a number they should not act
 * on. This module decomposes the COEBIS value on screen into the exact chain
 * of steps that produced it: the raw OpenIBIS index, the pooled affine map,
 * the knot (region) correction, and each patient-specific covariate term.
 */

import { covariateAdjustment, covariateLabel, type CaseCovariates } from "./covariates";
import { knotCorrection, type BisAlignment } from "./depth";
import type { AdjunctCorrection } from "./coebis-adjuncts";
import type { KetamineSignature } from "./ketamine";

export interface CoebisExplainStep {
  /** Short step name, e.g. "Patient adjustment: age 75-89". */
  label: string;
  /** Change in index points this step contributed. */
  delta: number;
  /** Running value after the step. */
  value: number;
  /** One sentence of plain-language justification. */
  detail: string;
}

export interface CoebisExplanation {
  available: boolean;
  raw: number | null;
  final: number | null;
  steps: CoebisExplainStep[];
  /** Total shift from OpenIBIS to COEBIS. */
  netShift: number;
  /** Model provenance line, e.g. "v4 · provisional · 22 paired readings". */
  provenance: string;
  caveats: string[];
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function explainCoebis(
  openIbis: number | null | undefined,
  alignment: BisAlignment | null | undefined,
  cov: CaseCovariates | null | undefined,
  adjunct?: AdjunctCorrection | null,
  ketamine?: KetamineSignature | null,
): CoebisExplanation {
  const caveats: string[] = [];
  if (openIbis == null || !alignment) {
    return {
      available: false,
      raw: openIbis ?? null,
      final: null,
      steps: [],
      netShift: 0,
      provenance: alignment ? "No index available" : "No COEBIS model fitted yet",
      caveats: alignment
        ? ["Waiting for a reliable depth index."]
        : ["COEBIS needs paired commercial-BIS readings before it can correct the index."],
    };
  }

  const steps: CoebisExplainStep[] = [];
  let value = openIbis;
  steps.push({
    label: "OpenIBIS raw index",
    delta: 0,
    value: Number(value.toFixed(1)),
    detail: "The published open-source index computed from this patient's spectrum.",
  });

  const affine = alignment.gain * openIbis + alignment.offset;
  steps.push({
    label: "Pooled alignment",
    delta: Number((affine - value).toFixed(1)),
    value: Number(affine.toFixed(1)),
    detail: `Straight-line correction fitted across all your paired readings (×${alignment.gain.toFixed(3)} ${alignment.offset >= 0 ? "+" : "−"} ${Math.abs(alignment.offset).toFixed(1)}).`,
  });
  value = affine;

  const knot = knotCorrection(affine, alignment.knots);
  if (knot !== 0) {
    value = affine + knot;
    steps.push({
      label: "Region correction",
      delta: Number(knot.toFixed(1)),
      value: Number(value.toFixed(1)),
      detail:
        "Residual correction for this part of the scale, where a single straight line still disagreed with the monitor.",
    });
  }

  const adj = covariateAdjustment(alignment.terms, cov);
  for (const part of adj.parts) {
    value += part.dy;
    steps.push({
      label: `Patient adjustment: ${covariateLabel(part.group, part.level)}`,
      delta: Number(part.dy.toFixed(1)),
      value: Number(value.toFixed(1)),
      detail: `Learned from ${part.n} paired reading${part.n === 1 ? "" : "s"} in this subgroup — something commercial BIS does not do.`,
    });
  }
  if (adj.parts.length && Math.abs(adj.total - adj.parts.reduce((s, p) => s + p.dy, 0)) > 0.05) {
    value = (value - adj.parts.reduce((s, p) => s + p.dy, 0)) + adj.total;
    steps.push({
      label: "Adjustment cap",
      delta: 0,
      value: Number(value.toFixed(1)),
      detail: "Total patient-specific adjustment is capped so covariates can nudge the index, never redefine it.",
    });
  }

  if (adjunct?.parts.length) {
    for (const part of adjunct.parts) {
      value += part.delta;
      steps.push({
        label: `Monitor adjunct: ${part.label}`,
        delta: Number(part.delta.toFixed(1)),
        value: Number(value.toFixed(1)),
        detail: part.vsCommercial ? `${part.detail} ${part.vsCommercial}` : part.detail,
      });
    }
    if (adjunct.shrink < 1) {
      caveats.push(
        `Adjunct corrections were shrunk to ${Math.round(adjunct.shrink * 100)} % because the hemispheres disagreed or the signal was poor.`,
      );
    }
    if (adjunct.capped) {
      caveats.push("The adjunct stage hit its cap; it can nudge the index, never redefine it.");
    }
  }

  if (ketamine?.corrected && ketamine.delta < 0) {
    value += ketamine.delta;
    steps.push({
      label: "Ketamine correction",
      delta: Number(ketamine.delta.toFixed(1)),
      value: Number(value.toFixed(1)),
      detail: ketamine.reasons.join(" "),
    });
    caveats.push(
      "Ketamine is recorded for this case: the beta/gamma activity it produces is treated as drug effect, not wakefulness. The correction is bounded, so still judge depth clinically.",
    );
  } else if (ketamine?.advisory) {
    caveats.push(
      "The spectrum shows the fast-frequency pattern ketamine produces, but no ketamine is recorded for this case. If it has been given, this index is reading high — record it so COEBIS can correct for it.",
    );
  } else if (ketamine?.exposure === "declared") {
    caveats.push(
      "Ketamine is recorded for this case; the index is being watched for spurious beta/gamma inflation, none of which is present in the current epoch.",
    );
  }

  const final = clamp(value, 0, 100);
  if (final !== value) {
    steps.push({
      label: "Clamped to 0–100",
      delta: Number((final - value).toFixed(1)),
      value: Number(final.toFixed(1)),
      detail: "The index scale is bounded.",
    });
  }

  if (alignment.provisional) {
    caveats.push("This fit is provisional — based on early evidence, below the full data bar.");
  }
  if (!adj.parts.length) {
    caveats.push(
      "No patient-specific adjustment applied: either the covariates are not recorded, or no subgroup term has been learned yet.",
    );
  }
  if (alignment.n < 30) {
    caveats.push(`Fitted on ${alignment.n} paired readings — more readings will tighten the correction.`);
  }

  const bits = [
    alignment.version ? `v${alignment.version}` : "unversioned",
    alignment.family ?? "affine",
    alignment.provisional ? "provisional" : "confirmed",
    `${alignment.n} paired reading${alignment.n === 1 ? "" : "s"}`,
  ];

  return {
    available: true,
    raw: Number(openIbis.toFixed(1)),
    final: Math.round(final),
    steps,
    netShift: Number((final - openIbis).toFixed(1)),
    provenance: bits.join(" · "),
    caveats,
  };
}
