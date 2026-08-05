/**
 * Runtime validation for the depth calibration stored in the database
 * (`depth_calibrations.params`/`metrics`) and in localStorage.
 *
 * These values feed the mixer that produces the depth index at the bedside,
 * so a malformed or partially-written record must be rejected rather than
 * silently cast into shape.
 */
import { z } from "zod";

import { DEFAULT_DEPTH_CALIBRATION, type DepthCalibration } from "@/lib/eeg/depth";

const finite = z.number().finite();

export const sigmoidWeightsSchema = z.object({
  eo: finite,
  emax: finite,
  x50: finite,
  xwidth: finite,
});

export const depthCalibrationSchema = z.object({
  sedation: sigmoidWeightsSchema,
  general: sigmoidWeightsSchema,
  // Older records predate the linear segment; fall back to the published one.
  generalLinear: z
    .object({ xLo: finite, xHi: finite, yLo: finite, yHi: finite })
    .default(DEFAULT_DEPTH_CALIBRATION.generalLinear),
});

export const fitMetricsSchema = z
  .object({
    samples: finite.optional(),
    rmse: finite.optional(),
    inRangeFraction: finite.optional(),
  })
  .passthrough();

/** Parse an untrusted calibration payload; returns null when unusable. */
export function parseDepthCalibration(value: unknown): DepthCalibration | null {
  const result = depthCalibrationSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Parse stored fit metrics; unknown extra keys are preserved. */
export function parseFitMetrics(value: unknown): Record<string, unknown> {
  const result = fitMetricsSchema.safeParse(value ?? {});
  return result.success ? result.data : {};
}
