import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  buildCaseFile,
  caseOptions,
  compareCases,
  type CaseComparison,
  type CaseFile,
  type CaseOption,
} from "@/lib/eeg/case-file";
import { gateStatus, type GateStatus, type ModelSource } from "@/lib/eeg/suppression-dashboard";
import { crossValidate, emptyReport } from "@/lib/eeg/suppression-model";

const Input = z.object({
  caseRef: z.string().min(1).max(200),
  /** Second case to line up beside the first. */
  vs: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(500).max(80000).optional(),
});

export interface CaseFileReport {
  gate: GateStatus;
  modelSource: ModelSource;
  primary: CaseFile;
  secondary: CaseFile | null;
  comparison: CaseComparison | null;
  options: CaseOption[];
}

/** One case across the three axes, optionally lined up against another. */
export const getCaseFile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<CaseFileReport> => {
    const { loadSuppressionPoints, SR_LINEAGE_PREFIX } = await import(
      "@/lib/eeg/suppression-model.server"
    );
    const { loadActiveSuppressionModel } = await import(
      "@/lib/eeg/suppression-promotion.server"
    );
    const { loadKetamineCases } = await import("@/lib/eeg/ketamine-cases.server");

    const [points, ketamine] = await Promise.all([
      loadSuppressionPoints(context.supabase, context.userId, data.limit ?? 80000),
      loadKetamineCases(context.supabase, 40000).catch(() => null),
    ]);
    const summaries = ketamine?.cases ?? [];

    const fit = points.length ? crossValidate(SR_LINEAGE_PREFIX, points) : emptyReport().fit;
    // The trace must show the calibration a clinician is actually reading, so
    // the freshly cross-validated fit is only a fallback and is never labelled
    // as promoted.
    const active = await loadActiveSuppressionModel(
      context.supabase,
      context.userId,
      SR_LINEAGE_PREFIX,
    ).catch(() => null);
    const model = active ? active.model : fit.model;
    const modelSource: ModelSource = active
      ? "promoted"
      : model
        ? "candidate fit"
        : "raw detector";

    const primary = buildCaseFile(data.caseRef, points, model, summaries, modelSource);
    const secondary =
      data.vs && data.vs !== data.caseRef
        ? buildCaseFile(data.vs, points, model, summaries, modelSource)
        : null;

    return {
      gate: gateStatus(fit),
      modelSource,
      primary,
      secondary,
      comparison: secondary ? compareCases(primary, secondary) : null,
      options: caseOptions(points, summaries),
    };
  });

export type { CaseFile, CaseOption, CaseComparison } from "@/lib/eeg/case-file";
