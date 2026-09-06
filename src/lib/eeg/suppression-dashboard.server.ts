/**
 * Server-side assembly of the suppression-versus-COEBIS dashboard.
 *
 * Extracted from the server function so the same computation can be run by the
 * cached analysis pass as well as on demand.
 */
import {
  buildSuppressionDashboard,
  gateStatus,
  MAX_DASHBOARD_CASES,
  newBisAccumulator,
  summariseBis,
  type SuppressionDashboard,
} from "@/lib/eeg/suppression-dashboard";
import { crossValidate, emptyReport } from "@/lib/eeg/suppression-model";

type Client = Parameters<typeof import("@/lib/eeg/suppression-model.server").loadSuppressionPoints>[0];

export function emptySuppressionDashboard(): SuppressionDashboard {
  return {
    gate: gateStatus(emptyReport().fit),
    modelSource: "raw detector",
    totals: { agreed: 0, missed: 0, falseAlarms: 0, clear: 0 },
    bisTotals: summariseBis(newBisAccumulator()),
    casesWithBis: 0,
    patients: 0,
    cases: [],
  };
}

export async function loadSuppressionDashboard(
  supabase: Client,
  userId: string,
  options: { limit?: number; cases?: number } = {},
): Promise<SuppressionDashboard> {
  const { loadSuppressionPoints, SR_LINEAGE_PREFIX } = await import(
    "@/lib/eeg/suppression-model.server"
  );
  const { loadActiveSuppressionModel } = await import(
    "@/lib/eeg/suppression-promotion.server"
  );

  const points = await loadSuppressionPoints(supabase, userId, options.limit ?? 40000);
  if (!points.length) return emptySuppressionDashboard();

  const fit = crossValidate(SR_LINEAGE_PREFIX, points);
  // Prefer the calibration actually in force; the freshly cross-validated fit
  // is only a fallback, and is never presented as promoted.
  const active = await loadActiveSuppressionModel(supabase, userId, SR_LINEAGE_PREFIX).catch(
    () => null,
  );

  return buildSuppressionDashboard(points, fit, {
    maxCases: options.cases ?? MAX_DASHBOARD_CASES,
    ...(active ? { activeModel: active.model, modelSource: "promoted" as const } : {}),
  });
}
