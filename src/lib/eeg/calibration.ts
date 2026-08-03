// Fit the openibis-style mixer sigmoids to labelled periods of your own
// recordings. The published constants stay the starting point; fitting only
// shifts/stretches the two sigmoids so that epochs you marked as awake,
// sedated, anaesthesia or burst suppression land in the expected index range.

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { DEFAULT_DEPTH_CALIBRATION, depthMixer, type DepthCalibration } from "@/lib/eeg/depth";

export type StateLabel = "awake" | "sedated" | "anaesthesia" | "burst_suppression";

export const STATE_LABELS: { value: StateLabel; label: string; target: [number, number] }[] = [
  { value: "awake", label: "Awake", target: [85, 100] },
  { value: "sedated", label: "Sedated", target: [65, 85] },
  { value: "anaesthesia", label: "General anaesthesia", target: [40, 60] },
  { value: "burst_suppression", label: "Burst suppression", target: [0, 20] },
];

export const TARGETS: Record<StateLabel, [number, number]> = Object.fromEntries(
  STATE_LABELS.map((s) => [s.value, s.target]),
) as Record<StateLabel, [number, number]>;

export const stateLabelName = (v: string) => STATE_LABELS.find((s) => s.value === v)?.label ?? v;

export interface LabelledPeriod {
  id: string;
  session_id: string;
  label: StateLabel;
  start_seconds: number;
  end_seconds: number;
  note: string | null;
}

/** One training sample: stored mixer inputs plus the state you labelled. */
export interface CalibrationSample {
  t: number;
  sessionId: string;
  c1: number;
  c2: number;
  c3: number;
  bsr: number;
  label: StateLabel;
}

export interface FitMetrics {
  samples: number;
  perState: { label: StateLabel; n: number; meanIndex: number; inRange: number }[];
  rmse: number;
  inRangeFraction: number;
}

export interface FitResult {
  calibration: DepthCalibration;
  before: FitMetrics;
  after: FitMetrics;
}

const mid = (r: [number, number]) => (r[0] + r[1]) / 2;

export function predictIndex(s: CalibrationSample, cal: DepthCalibration): number {
  const { index } = depthMixer(s.c1, s.c2, s.c3, s.bsr, cal);
  return Math.min(100, Math.max(0, index));
}

export function evaluate(samples: CalibrationSample[], cal: DepthCalibration): FitMetrics {
  const perState = STATE_LABELS.map(({ value }) => {
    const rows = samples.filter((s) => s.label === value);
    const preds = rows.map((s) => predictIndex(s, cal));
    const range = TARGETS[value];
    return {
      label: value,
      n: rows.length,
      meanIndex: preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : NaN,
      inRange: preds.length
        ? preds.filter((p) => p >= range[0] && p <= range[1]).length / preds.length
        : NaN,
    };
  }).filter((r) => r.n > 0);

  let se = 0;
  let inRange = 0;
  for (const s of samples) {
    const p = predictIndex(s, cal);
    se += (p - mid(TARGETS[s.label])) ** 2;
    const r = TARGETS[s.label];
    if (p >= r[0] && p <= r[1]) inRange++;
  }
  return {
    samples: samples.length,
    perState,
    rmse: samples.length ? Math.sqrt(se / samples.length) : NaN,
    inRangeFraction: samples.length ? inRange / samples.length : NaN,
  };
}

/* ------------------------------------------------------------------ */
/* Fitting                                                             */

const PARAM_KEYS = [
  ["sedation", "eo"],
  ["sedation", "emax"],
  ["sedation", "x50"],
  ["sedation", "xwidth"],
  ["general", "eo"],
  ["general", "emax"],
  ["general", "x50"],
  ["general", "xwidth"],
  ["generalLinear", "yLo"],
  ["generalLinear", "yHi"],
  ["generalLinear", "xLo"],
  ["generalLinear", "xHi"],
] as const;

function toVector(cal: DepthCalibration): number[] {
  return PARAM_KEYS.map(([g, p]) => (cal[g] as Record<string, number>)[p]!);
}

function fromVector(v: number[]): DepthCalibration {
  const cal: DepthCalibration = {
    sedation: { ...DEFAULT_DEPTH_CALIBRATION.sedation },
    general: { ...DEFAULT_DEPTH_CALIBRATION.general },
    generalLinear: { ...DEFAULT_DEPTH_CALIBRATION.generalLinear },
  };
  PARAM_KEYS.forEach(([g, p], i) => {
    (cal[g] as Record<string, number>)[p] = v[i]!;
  });
  // Keep the sigmoids well formed.
  cal.sedation.xwidth = Math.max(0.5, cal.sedation.xwidth);
  cal.general.xwidth = Math.max(0.5, cal.general.xwidth);
  cal.sedation.emax = Math.max(1, cal.sedation.emax);
  cal.general.emax = Math.max(1, cal.general.emax);
  // The linear segment must stay monotone increasing in x.
  cal.generalLinear.xHi = Math.max(cal.generalLinear.xLo + 1, cal.generalLinear.xHi);
  return cal;
}

/**
 * Hinge loss: no penalty inside the state's target band, squared distance
 * outside it, plus a small pull back toward the published constants so a few
 * labelled minutes cannot produce an absurd sigmoid.
 */
function loss(v: number[], samples: CalibrationSample[], regularisation: number): number {
  const cal = fromVector(v);
  let total = 0;
  for (const s of samples) {
    const p = predictIndex(s, cal);
    const [lo, hi] = TARGETS[s.label];
    // Aim a little inside the band so the optimum does not sit on its edge.
    const inset = 0.15 * (hi - lo);
    const a = lo + inset;
    const b = hi - inset;
    const d = p < a ? a - p : p > b ? p - b : 0;
    total += d * d;
  }
  total /= Math.max(1, samples.length);
  const base = toVector(DEFAULT_DEPTH_CALIBRATION);
  let reg = 0;
  for (let i = 0; i < v.length; i++) {
    const scale = Math.max(1, Math.abs(base[i]!));
    reg += ((v[i]! - base[i]!) / scale) ** 2;
  }
  return total + regularisation * reg;
}

/** Nelder-Mead simplex minimiser (no dependencies, deterministic). */
function nelderMead(
  f: (v: number[]) => number,
  start: number[],
  steps: number[],
  iterations = 1200,
): number[] {
  const n = start.length;
  const simplex: { x: number[]; y: number }[] = [{ x: [...start], y: f(start) }];
  for (let i = 0; i < n; i++) {
    const x = [...start];
    x[i] = x[i]! + steps[i]!;
    simplex.push({ x, y: f(x) });
  }
  const centroid = (excl: number) => {
    const c = new Array(n).fill(0);
    for (let i = 0; i < simplex.length; i++) {
      if (i === excl) continue;
      for (let j = 0; j < n; j++) c[j] += simplex[i]!.x[j]! / (simplex.length - 1);
    }
    return c;
  };
  for (let it = 0; it < iterations; it++) {
    simplex.sort((a, b) => a.y - b.y);
    const best = simplex[0]!;
    const worst = simplex[simplex.length - 1]!;
    if (Math.abs(worst.y - best.y) < 1e-9) break;
    const c = centroid(simplex.length - 1);
    const reflect = c.map((v, j) => v + (v - worst.x[j]!));
    const yr = f(reflect);
    if (yr < best.y) {
      const expand = c.map((v, j) => v + 2 * (v - worst.x[j]!));
      const ye = f(expand);
      simplex[simplex.length - 1] = ye < yr ? { x: expand, y: ye } : { x: reflect, y: yr };
    } else if (yr < simplex[simplex.length - 2]!.y) {
      simplex[simplex.length - 1] = { x: reflect, y: yr };
    } else {
      const contract = c.map((v, j) => v + 0.5 * (worst.x[j]! - v));
      const yc = f(contract);
      if (yc < worst.y) {
        simplex[simplex.length - 1] = { x: contract, y: yc };
      } else {
        for (let i = 1; i < simplex.length; i++) {
          const x = simplex[i]!.x.map((v, j) => best.x[j]! + 0.5 * (v - best.x[j]!));
          simplex[i] = { x, y: f(x) };
        }
      }
    }
  }
  simplex.sort((a, b) => a.y - b.y);
  return simplex[0]!.x;
}

export function fitCalibration(samples: CalibrationSample[], regularisation = 0.5): FitResult {
  const start = toVector(DEFAULT_DEPTH_CALIBRATION);
  const steps = [8, 8, 3, 1.5, 8, 8, 3, 1.5, 8, 8, 4, 2];
  const best = nelderMead((v) => loss(v, samples, regularisation), start, steps);
  const calibration = fromVector(best);
  return {
    calibration,
    before: evaluate(samples, DEFAULT_DEPTH_CALIBRATION),
    after: evaluate(samples, calibration),
  };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */

export const ACTIVE_CAL_STORAGE_KEY = "eeg.depth.calibration";

export function loadStoredCalibration(): DepthCalibration | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_CAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DepthCalibration;
    if (!parsed?.sedation || !parsed?.general) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeCalibration(cal: DepthCalibration | null) {
  if (typeof window === "undefined") return;
  if (cal) window.localStorage.setItem(ACTIVE_CAL_STORAGE_KEY, JSON.stringify(cal));
  else window.localStorage.removeItem(ACTIVE_CAL_STORAGE_KEY);
}

export async function fetchLabels(sessionId: string): Promise<LabelledPeriod[]> {
  const { data, error } = await supabase
    .from("depth_state_labels")
    .select("id, session_id, label, start_seconds, end_seconds, note")
    .eq("session_id", sessionId)
    .order("start_seconds");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    session_id: r.session_id,
    label: r.label as StateLabel,
    start_seconds: Number(r.start_seconds),
    end_seconds: Number(r.end_seconds),
    note: r.note,
  }));
}

export async function addLabel(
  sessionId: string,
  label: StateLabel,
  start: number,
  end: number,
  note?: string,
) {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("You need to be signed in.");
  const { error } = await supabase.from("depth_state_labels").insert({
    user_id: userId,
    session_id: sessionId,
    label,
    start_seconds: Math.min(start, end),
    end_seconds: Math.max(start, end),
    note: note?.trim() || null,
  });
  if (error) throw error;
}

export async function deleteLabel(id: string) {
  const { error } = await supabase.from("depth_state_labels").delete().eq("id", id);
  if (error) throw error;
}

type CalibrationRow = Pick<
  Tables<"depth_calibrations">,
  "id" | "name" | "params" | "metrics" | "is_active" | "created_at"
>;

export interface StoredCalibration {
  id: string;
  name: string;
  params: DepthCalibration;
  metrics: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
}

/** Narrow the two JSON columns; the rest of the row is already typed. */
function toStoredCalibration(row: CalibrationRow): StoredCalibration {
  return {
    id: row.id,
    name: row.name,
    is_active: row.is_active,
    created_at: row.created_at,
    params: row.params as unknown as DepthCalibration,
    metrics: (row.metrics ?? {}) as Record<string, unknown>,
  };
}

export async function fetchCalibrations(): Promise<StoredCalibration[]> {
  const { data, error } = await supabase
    .from("depth_calibrations")
    .select("id, name, params, metrics, is_active, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toStoredCalibration);
}

export async function saveCalibration(
  name: string,
  params: DepthCalibration,
  metrics: FitMetrics,
  sessionIds: string[],
): Promise<StoredCalibration> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("You need to be signed in.");
  const { data, error } = await supabase
    .from("depth_calibrations")
    .insert({
      user_id: userId,
      name,
      params: JSON.parse(JSON.stringify(params)),
      metrics: JSON.parse(JSON.stringify(metrics)),
      source_session_ids: sessionIds,
    })
    .select("id, name, params, metrics, is_active, created_at")
    .single();
  if (error) throw error;
  return toStoredCalibration(data);
}

export async function setActiveStored(id: string | null) {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return;
  await supabase.from("depth_calibrations").update({ is_active: false }).eq("user_id", userId);
  if (id) await supabase.from("depth_calibrations").update({ is_active: true }).eq("id", id);
}

export async function deleteCalibration(id: string) {
  const { error } = await supabase.from("depth_calibrations").delete().eq("id", id);
  if (error) throw error;
}

/** Join stored epochs with labelled periods to build the training set. */
export async function buildSamples(sessionIds: string[]): Promise<CalibrationSample[]> {
  if (!sessionIds.length) return [];
  const [{ data: epochs, error: e1 }, { data: labels, error: e2 }] = await Promise.all([
    supabase
      .from("eeg_epochs")
      .select("session_id, t_offset_seconds, depth_components")
      .in("session_id", sessionIds)
      .order("t_offset_seconds"),
    supabase
      .from("depth_state_labels")
      .select("session_id, label, start_seconds, end_seconds")
      .in("session_id", sessionIds),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const samples: CalibrationSample[] = [];
  for (const row of epochs ?? []) {
    const comp = row.depth_components as {
      c1?: number;
      c2?: number;
      c3?: number;
      bsr?: number;
    } | null;
    if (!comp || ![comp.c1, comp.c2, comp.c3, comp.bsr].every((v) => Number.isFinite(v))) continue;
    const t = Number(row.t_offset_seconds);
    const match = (labels ?? []).find(
      (l) =>
        l.session_id === row.session_id &&
        t >= Number(l.start_seconds) &&
        t <= Number(l.end_seconds),
    );
    if (!match) continue;
    samples.push({
      t,
      sessionId: row.session_id,
      c1: comp.c1!,
      c2: comp.c2!,
      c3: comp.c3!,
      bsr: comp.bsr!,
      label: match.label as StateLabel,
    });
  }
  return samples;
}
