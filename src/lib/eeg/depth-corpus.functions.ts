import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const PointInput = z.object({
  atSeconds: z.number(),
  reference: z.number().min(0).max(100),
  appIndex: z.number(),
  appSef: z.number().nullable(),
  appSr: z.number().nullable(),
  refSr: z.number().nullable(),
  refSef: z.number().nullable(),
  sqi: z.number().nullable(),
  lagSeconds: z.number(),
  externalRef: z.string().min(1),
});

const CaseInput = z.object({
  caseRef: z.string().min(1),
  points: z.array(PointInput).min(1),
});

const ImportInput = z.object({
  corpusId: z.string().min(1).max(80),
  corpusLabel: z.string().min(1).max(120),
  lineageKey: z.string().min(1),
  deviceId: z.string().min(1),
  channel: z.string().min(1),
  sampleRate: z.number().positive(),
  scoreLabel: z.string().min(1).max(60),
  licence: z.string().max(120).nullable(),
  cases: z.array(CaseInput).min(1).max(200),
});

export type DepthCorpusImportInput = z.infer<typeof ImportInput>;

export interface DepthCorpusImportResult {
  cases: number;
  inserted: number;
  skipped: number;
  lineageKey: string;
}

/** File a replayed corpus as paired readings under its own lineage. */
export const importDepthCorpus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => ImportInput.parse(data))
  .handler(async ({ data, context }): Promise<DepthCorpusImportResult> => {
    const { supabase, userId } = context;
    const rows = data.cases.flatMap((c) =>
      c.points.map((p) => ({
        user_id: userId,
        session_id: null,
        at_seconds: p.atSeconds,
        bis: p.reference,
        bis_sef: p.refSef,
        bis_sr: p.refSr,
        app_index: p.appIndex,
        app_sef: p.appSef,
        app_sr: p.appSr,
        reliable: p.sqi == null ? true : p.sqi >= 50,
        sqi: p.sqi == null ? null : p.sqi / 100,
        lag_seconds: p.lagSeconds,
        context: "general",
        device: data.deviceId,
        source: `upload:${data.corpusId}`,
        source_site: "upload",
        source_lineage: data.lineageKey,
        feature_source: "replay",
        external_ref: p.externalRef,
        // No demographics, drug regimen or frailty are claimed: an uploaded
        // corpus that does not state them must read as absent to the refit.
        features: {
          imported: true,
          replayed: true,
          corpus: data.corpusLabel,
          scoreLabel: data.scoreLabel,
          channel: data.channel,
          sampleRate: data.sampleRate,
          licence: data.licence,
          caseRef: c.caseRef,
          ageBand: null,
          sex: null,
          regimen: null,
          frailty: null,
        } as unknown as never,
      })),
    );

    // Re-uploading the same file must not double-count: every reading carries
    // a stable reference built from corpus, case and time.
    const refs = rows.map((r) => r.external_ref);
    const existing = new Set<string>();
    for (let i = 0; i < refs.length; i += 500) {
      const { data: found, error } = await supabase
        .from("bis_paired_points")
        .select("external_ref")
        .eq("user_id", userId)
        .in("external_ref", refs.slice(i, i + 500));
      if (error) throw new Error(error.message);
      for (const r of (found ?? []) as unknown as { external_ref: string | null }[]) {
        if (r.external_ref) existing.add(r.external_ref);
      }
    }

    const fresh = rows.filter((r) => !existing.has(r.external_ref));
    for (let i = 0; i < fresh.length; i += 500) {
      const { error } = await supabase
        .from("bis_paired_points")
        .insert(fresh.slice(i, i + 500) as never);
      if (error) throw new Error(error.message);
    }

    return {
      cases: new Set(
        fresh.map((r) => (r.features as unknown as { caseRef: string }).caseRef),
      ).size,
      inserted: fresh.length,
      skipped: rows.length - fresh.length,
      lineageKey: data.lineageKey,
    };
  });

export interface CorpusLineageRow {
  lineageKey: string;
  readings: number;
  cases: number;
  source: string | null;
}

/** What each uploaded corpus already holds, and whether it clears the gate. */
export const getCorpusLineages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ lineages: CorpusLineageRow[] }> => {
    const { supabase, userId } = context;
    const byLineage = new Map<string, { readings: number; cases: Set<string>; source: string | null }>();
    const PAGE = 1000;
    for (let from = 0; from < 20000; from += PAGE) {
      const { data, error } = await supabase
        .from("bis_paired_points")
        .select("source_lineage, source, external_ref, features")
        .eq("user_id", userId)
        .like("source", "upload:%")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data ?? []) as unknown as {
        source_lineage: string | null;
        source: string | null;
        features: { caseRef?: string } | null;
      }[];
      for (const r of page) {
        const key = r.source_lineage ?? "unfiled";
        let entry = byLineage.get(key);
        if (!entry) {
          entry = { readings: 0, cases: new Set(), source: r.source };
          byLineage.set(key, entry);
        }
        entry.readings++;
        if (r.features?.caseRef) entry.cases.add(r.features.caseRef);
      }
      if (page.length < PAGE) break;
    }
    return {
      lineages: [...byLineage.entries()]
        .map(([lineageKey, v]) => ({
          lineageKey,
          readings: v.readings,
          cases: v.cases.size,
          source: v.source,
        }))
        .sort((a, b) => b.readings - a.readings),
    };
  });
