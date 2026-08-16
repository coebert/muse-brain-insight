/**
 * Phase 6 — de-identified data exchange.
 *
 * A single anaesthetist accumulates paired readings slowly. Pooling them
 * across devices or colleagues is the fastest route to a COEBIS fit that
 * generalises. The exchange format therefore carries only what the model
 * learns from: the two numbers, the signal-quality context, and the coarse
 * covariates. No case codes, no clock times, no free text, no patient
 * identifiers of any kind — dates are reduced to the month.
 */

export const EXCHANGE_VERSION = 1;

export interface ExchangePoint {
  /** Stable id for the reading, so re-importing a file cannot duplicate it. */
  ref: string;
  /** Opaque per-bundle case grouping, so per-case structure survives. */
  caseRef: string;
  /** Case-clock seconds within its own case. */
  at: number;
  bis: number;
  appIndex: number;
  appSr: number | null;
  bisSef: number | null;
  appSef: number | null;
  reliable: boolean;
  sqi: number | null;
  context: string | null;
  ageBand: string | null;
  sex: string | null;
  regimen: string | null;
  frailty: string | null;
  /** Month the reading was taken, "2026-08". */
  month: string | null;
}

export interface ExchangeBundle {
  format: "cortextrace.paired.v1";
  version: number;
  exportedAt: string;
  site: string;
  points: ExchangePoint[];
}

function monthOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Short stable hash, used to pseudonymise case ids inside a bundle. */
export function pseudonym(value: string, salt: string): string {
  let h = 2166136261 >>> 0;
  const s = `${salt}:${value}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

export interface RawPointRow {
  id: string;
  session_id: string | null;
  at_seconds: number | string;
  bis: number | string;
  app_index: number | string;
  app_sr: number | string | null;
  bis_sef: number | string | null;
  app_sef: number | string | null;
  reliable: boolean;
  sqi: number | string | null;
  context: string | null;
  recorded_at: string;
}

export interface RawCaseCovariates {
  age_band: string | null;
  sex: string | null;
  regimen: string | null;
  frailty: string | null;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Build a shareable bundle from stored rows, stripping everything identifying. */
export function buildExchangeBundle(
  rows: RawPointRow[],
  covariates: Map<string, RawCaseCovariates>,
  site: string,
  salt: string,
): ExchangeBundle {
  const points: ExchangePoint[] = rows
    .map((r) => {
      const bis = num(r.bis);
      const appIndex = num(r.app_index);
      if (bis == null || appIndex == null) return null;
      const cov = r.session_id ? covariates.get(r.session_id) : undefined;
      return {
        ref: pseudonym(r.id, salt),
        caseRef: pseudonym(r.session_id ?? "unfiled", salt),
        at: num(r.at_seconds) ?? 0,
        bis,
        appIndex,
        appSr: num(r.app_sr),
        bisSef: num(r.bis_sef),
        appSef: num(r.app_sef),
        reliable: Boolean(r.reliable),
        sqi: num(r.sqi),
        context: r.context ?? null,
        ageBand: cov?.age_band ?? null,
        sex: cov?.sex ?? null,
        regimen: cov?.regimen ?? null,
        frailty: cov?.frailty ?? null,
        month: monthOf(r.recorded_at),
      } satisfies ExchangePoint;
    })
    .filter((p): p is ExchangePoint => p !== null);

  return {
    format: "cortextrace.paired.v1",
    version: EXCHANGE_VERSION,
    exportedAt: new Date().toISOString(),
    site,
    points,
  };
}

export interface ParsedBundle {
  ok: boolean
  error?: string;
  bundle?: ExchangeBundle;
}

/** Validate an uploaded bundle before anything is written. */
export function parseExchangeBundle(input: unknown): ParsedBundle {
  const b = input as Partial<ExchangeBundle> | null;
  if (!b || typeof b !== "object") return { ok: false, error: "Not a JSON object." };
  if (b.format !== "cortextrace.paired.v1") {
    return { ok: false, error: "Unrecognised file — expected a CortexTrace paired-reading export." };
  }
  if (!Array.isArray(b.points) || !b.points.length) {
    return { ok: false, error: "The file contains no readings." };
  }
  const clean: ExchangePoint[] = [];
  for (const raw of b.points) {
    const p = raw as Partial<ExchangePoint>;
    const bis = num(p.bis);
    const appIndex = num(p.appIndex);
    if (bis == null || appIndex == null) continue;
    if (bis < 0 || bis > 100 || appIndex < 0 || appIndex > 100) continue;
    if (!p.ref || typeof p.ref !== "string") continue;
    clean.push({
      ref: p.ref,
      caseRef: typeof p.caseRef === "string" ? p.caseRef : "unfiled",
      at: num(p.at) ?? 0,
      bis,
      appIndex,
      appSr: num(p.appSr),
      bisSef: num(p.bisSef),
      appSef: num(p.appSef),
      reliable: p.reliable !== false,
      sqi: num(p.sqi),
      context: typeof p.context === "string" ? p.context : null,
      ageBand: typeof p.ageBand === "string" ? p.ageBand : null,
      sex: typeof p.sex === "string" ? p.sex : null,
      regimen: typeof p.regimen === "string" ? p.regimen : null,
      frailty: typeof p.frailty === "string" ? p.frailty : null,
      month: typeof p.month === "string" ? p.month : null,
    });
  }
  if (!clean.length) return { ok: false, error: "No usable readings in the file." };
  return {
    ok: true,
    bundle: {
      format: "cortextrace.paired.v1",
      version: Number(b.version) || EXCHANGE_VERSION,
      exportedAt: typeof b.exportedAt === "string" ? b.exportedAt : new Date().toISOString(),
      site: typeof b.site === "string" ? b.site : "unknown site",
      points: clean,
    },
  };
}
