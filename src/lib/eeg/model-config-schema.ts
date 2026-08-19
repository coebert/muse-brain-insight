/**
 * Runtime + TypeScript validation for per-lineage model configuration.
 *
 * COEBIS coefficients and validated detector thresholds are only meaningful
 * alongside the acquisition lineage they were fitted on, and the shape of both
 * has changed over the life of the app (thresholds were once
 * `seizureScoreThreshold`/`seizureMinEpochs`; alignments once had no knots or
 * covariate terms). A record written by an older build, or by a different
 * device's tooling, must be rejected or explicitly migrated at the boundary —
 * never coerced with `Number(...)` into a plausible-looking number that then
 * drives a bedside index.
 *
 * Everything here parses untrusted input (database rows, localStorage, an
 * uploaded config) and returns either a typed value or the reasons it failed.
 */
import { z } from "zod";

import { ANALYSIS_CHANNELS, type AnalysisChannel } from "./device-profile";
import { MIN_USABLE_SAMPLE_RATE, lineageKey, parseLineageKey, type DataLineage } from "./model-lineage";

const finite = z.number().finite();

/* ------------------------------------------------------------------ */
/* Result type                                                         */
/* ------------------------------------------------------------------ */

export type ConfigResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; issues: string[] };

function fail(issues: string[]): { ok: false; issues: string[] } {
  return { ok: false, issues };
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
}

/* ------------------------------------------------------------------ */
/* Lineage                                                             */
/* ------------------------------------------------------------------ */

export const analysisChannelSchema = z.enum(
  ANALYSIS_CHANNELS as unknown as [AnalysisChannel, ...AnalysisChannel[]],
);

export const dataLineageSchema = z.object({
  deviceId: z.string().min(1),
  deviceLabel: z.string().min(1),
  transport: z.enum(["ble", "ingest", "simulated"]),
  channels: z.array(analysisChannelSchema),
  sampleRate: finite.min(1).max(20000),
});

/** A lineage key must round-trip through the parser used at the bedside. */
export const lineageKeySchema = z
  .string()
  .min(1)
  .refine((k) => parseLineageKey(k) !== null, "not a valid lineage key");

/* ------------------------------------------------------------------ */
/* Detector thresholds                                                 */
/* ------------------------------------------------------------------ */

/** Legacy field names, mapped to their current equivalents. */
const LEGACY_THRESHOLD_KEYS: Record<string, string> = {
  seizureScoreThreshold: "seizureThreshold",
  seizureMinEpochs: "seizureEpochs",
  suppressionUv: "suppressionThresholdUv",
  srWindow: "srWindowSeconds",
};

export const detectorThresholdSchema = z
  .object({
    seizureThreshold: finite.min(0).max(2),
    seizureEpochs: z.number().int().min(1).max(60),
    suppressionThresholdUv: finite.min(0.5).max(100),
    srWindowSeconds: finite.min(5).max(600),
  })
  .strict();

export type DetectorThresholdConfig = z.infer<typeof detectorThresholdSchema>;

/**
 * Parse detector thresholds. Legacy key names are rejected by default; pass
 * `{ migrate: true }` to accept them, in which case the rename is reported as
 * a warning so the caller can rewrite the stored record.
 */
export function parseDetectorThresholds(
  value: unknown,
  opts: { migrate?: boolean } = {},
): ConfigResult<DetectorThresholdConfig> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(["expected an object of detector thresholds"]);
  }
  const input = { ...(value as Record<string, unknown>) };
  const warnings: string[] = [];
  for (const [legacy, current] of Object.entries(LEGACY_THRESHOLD_KEYS)) {
    if (!(legacy in input)) continue;
    if (!opts.migrate) {
      return fail([
        `${legacy}: legacy threshold field, renamed to ${current} — refit or migrate this config`,
      ]);
    }
    if (!(current in input)) input[current] = input[legacy];
    delete input[legacy];
    warnings.push(`migrated ${legacy} → ${current}`);
  }
  const parsed = detectorThresholdSchema.safeParse(input);
  if (!parsed.success) return fail(issuesOf(parsed.error));
  return { ok: true, value: parsed.data, warnings };
}

/* ------------------------------------------------------------------ */
/* COEBIS alignment model                                              */
/* ------------------------------------------------------------------ */

export const MODEL_FAMILIES = ["affine", "affine-knots", "covariate", "mixed"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export const knotSchema = z.object({ x: finite.min(0).max(100), dy: finite.min(-40).max(40) });

export const covariateTermSchema = z.object({
  group: z.string().min(1),
  level: z.string().min(1),
  dy: finite.min(-40).max(40),
  n: z.number().int().min(0),
});

export const coebisModelSchema = z
  .object({
    modelVersion: z.string().min(1),
    modelFamily: z.enum(MODEL_FAMILIES),
    lineageKey: lineageKeySchema.nullable().default(null),
    gain: finite.min(0.1).max(5),
    offset: finite.min(-50).max(50),
    knots: z.array(knotSchema).max(32).default([]),
    terms: z.array(covariateTermSchema).max(64).default([]),
    nPoints: z.number().int().min(0).default(0),
    nSessions: z.number().int().min(0).default(0),
  })
  .superRefine((m, ctx) => {
    if (m.modelFamily === "affine" && m.knots.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["knots"],
        message: "an affine model must not carry knots — the family and coefficients disagree",
      });
    }
    if (m.modelFamily === "affine-knots" && m.terms.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terms"],
        message: "covariate terms require the covariate or mixed family",
      });
    }
    if ((m.modelFamily === "covariate" || m.modelFamily === "mixed") && m.terms.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terms"],
        message: `the ${m.modelFamily} family requires at least one covariate term`,
      });
    }
    const seen = new Set<number>();
    for (const k of m.knots) {
      if (seen.has(k.x)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knots"],
          message: `duplicate knot at x=${k.x}`,
        });
      }
      seen.add(k.x);
    }
  });

export type CoebisModelConfig = z.infer<typeof coebisModelSchema>;

export function parseCoebisModel(value: unknown): ConfigResult<CoebisModelConfig> {
  const parsed = coebisModelSchema.safeParse(value);
  if (!parsed.success) return fail(issuesOf(parsed.error));
  const warnings: string[] = [];
  if (!parsed.data.lineageKey) {
    warnings.push("no lineage recorded — model may only run provisionally");
  }
  return { ok: true, value: parsed.data, warnings };
}

/* ------------------------------------------------------------------ */
/* Per-lineage config bundle                                           */
/* ------------------------------------------------------------------ */

export interface LineageModelConfig {
  lineageKey: string;
  lineage: DataLineage;
  model: CoebisModelConfig | null;
  thresholds: DetectorThresholdConfig;
}

export interface LineageConfigParse {
  configs: LineageModelConfig[];
  /** Entries that were rejected, with the reason, keyed by their raw key. */
  rejected: { key: string; issues: string[] }[];
  warnings: string[];
}

/**
 * Parse a `{ [lineageKey]: { model, thresholds } }` bundle. Unusable entries
 * are dropped with their reasons rather than failing the whole bundle, so one
 * stale record cannot take the bedside offline.
 */
export function parseLineageConfigs(
  value: unknown,
  opts: { migrate?: boolean } = {},
): LineageConfigParse {
  const out: LineageConfigParse = { configs: [], rejected: [], warnings: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    out.rejected.push({ key: "<root>", issues: ["expected an object keyed by lineage"] });
    return out;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const lineage = parseLineageKey(key);
    if (!lineage) {
      out.rejected.push({ key, issues: ["not a valid lineage key"] });
      continue;
    }
    if (lineage.sampleRate < MIN_USABLE_SAMPLE_RATE) {
      out.rejected.push({
        key,
        issues: [`sample rate ${lineage.sampleRate} Hz is below the ${MIN_USABLE_SAMPLE_RATE} Hz analysis floor`],
      });
      continue;
    }
    const entry = (raw ?? {}) as { model?: unknown; thresholds?: unknown };
    const thresholds = parseDetectorThresholds(entry.thresholds, opts);
    if (!thresholds.ok) {
      out.rejected.push({ key, issues: thresholds.issues.map((i) => `thresholds.${i}`) });
      continue;
    }
    let model: CoebisModelConfig | null = null;
    if (entry.model != null) {
      const parsedModel = parseCoebisModel(entry.model);
      if (!parsedModel.ok) {
        out.rejected.push({ key, issues: parsedModel.issues.map((i) => `model.${i}`) });
        continue;
      }
      if (parsedModel.value.lineageKey && parsedModel.value.lineageKey !== key) {
        out.rejected.push({
          key,
          issues: [
            `model.lineageKey ${parsedModel.value.lineageKey} does not match the bundle key — a model from another acquisition setup`,
          ],
        });
        continue;
      }
      model = parsedModel.value;
      out.warnings.push(...parsedModel.warnings.map((w) => `${key}: ${w}`));
    }
    out.warnings.push(...thresholds.warnings.map((w) => `${key}: ${w}`));
    out.configs.push({ lineageKey: key, lineage, model, thresholds: thresholds.value });
  }
  return out;
}

/** Pick the config filed for a lineage, if one validated. */
export function configForLineage(
  parsed: LineageConfigParse,
  lineage: DataLineage,
): LineageModelConfig | null {
  const key = lineageKey(lineage);
  return parsed.configs.find((c) => c.lineageKey === key) ?? null;
}
