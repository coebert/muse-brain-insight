/** Server-only export/import of de-identified paired readings (Phase 6). */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildExchangeBundle,
  parseExchangeBundle,
  type ExchangeBundle,
  type RawCaseCovariates,
  type RawPointRow,
} from "./exchange";
import type { ImportResult } from "./exchange.functions";

type Client = SupabaseClient<any, any, any>;

export async function buildExportForUser(
  supabase: Client,
  userId: string,
  site: string,
): Promise<ExchangeBundle> {
  const { data, error } = await supabase
    .from("bis_paired_points")
    .select(
      "id, session_id, at_seconds, bis, app_index, app_sr, bis_sef, app_sef, reliable, sqi, context, recorded_at",
    )
    .order("recorded_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as RawPointRow[];

  const sessionIds = [...new Set(rows.map((r) => r.session_id).filter((v): v is string => !!v))];
  const covariates = new Map<string, RawCaseCovariates>();
  if (sessionIds.length) {
    const { data: sessions } = await supabase
      .from("eeg_sessions")
      .select("id, age_band, sex, regimen, frailty")
      .in("id", sessionIds);
    for (const s of (sessions ?? []) as unknown as (RawCaseCovariates & { id: string })[]) {
      covariates.set(s.id, s);
    }
  }

  // The salt is the account id, so the same case keeps the same pseudonym
  // across exports while never revealing the underlying case identifier.
  return buildExchangeBundle(rows, covariates, site.trim() || "unnamed site", userId);
}

export async function importBundleForUser(
  supabase: Client,
  userId: string,
  input: unknown,
): Promise<ImportResult> {
  const parsed = parseExchangeBundle(input);
  if (!parsed.ok || !parsed.bundle) {
    return { inserted: 0, skipped: 0, site: "", error: parsed.error ?? "Unreadable file." };
  }
  const bundle = parsed.bundle;
  const site = bundle.site;

  const refs = bundle.points.map((p) => `${site}:${p.ref}`);
  const { data: existingRows } = await supabase
    .from("bis_paired_points")
    .select("external_ref")
    .in("external_ref", refs);
  const existing = new Set(
    ((existingRows ?? []) as unknown as { external_ref: string | null }[])
      .map((r) => r.external_ref)
      .filter((v): v is string => !!v),
  );

  const rows = bundle.points
    .filter((p) => !existing.has(`${site}:${p.ref}`))
    .map((p) => ({
      user_id: userId,
      session_id: null,
      at_seconds: p.at,
      bis: p.bis,
      app_index: p.appIndex,
      app_sr: p.appSr,
      bis_sef: p.bisSef,
      app_sef: p.appSef,
      reliable: p.reliable,
      sqi: p.sqi,
      context: p.context,
      device: "imported",
      source: "import",
      source_site: site,
      external_ref: `${site}:${p.ref}`,
      // Covariates travel with the reading; they are re-attached through the
      // features column since imported readings have no local case to join to.
      features: {
        imported: true,
        caseRef: p.caseRef,
        ageBand: p.ageBand,
        sex: p.sex,
        regimen: p.regimen,
        frailty: p.frailty,
        month: p.month,
      } as unknown as never,
    }));

  if (!rows.length) {
    return { inserted: 0, skipped: bundle.points.length, site };
  }
  const { error } = await supabase.from("bis_paired_points").insert(rows);
  if (error) throw new Error(error.message);
  return { inserted: rows.length, skipped: bundle.points.length - rows.length, site };
}
