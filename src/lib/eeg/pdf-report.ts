/**
 * One-click session PDF report.
 *
 * Renders the whole-case density spectral array, the burst-suppression
 * timeline (with suppression ratio and suppression time) and the detected
 * seizure onsets/durations into an A4 landscape PDF using offscreen canvases,
 * so the export looks the same regardless of the screen it was triggered from.
 */
import { jsPDF } from "jspdf";

import { DSA_MAX_HZ, DSA_MIN_HZ } from "@/lib/eeg/analysis";
import { DSA_STOPS, dsaColor, paintDsaHeatmap } from "@/lib/eeg/dsa-render";
import type { EpochRow, EventRow } from "@/lib/eeg/db-rows";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { spansGap } from "@/lib/eeg/gaps";

export interface ReportSessionMeta {
  case_code?: string | null;
  context?: string | null;
  location?: string | null;
  device_name?: string | null;
  age_years?: number | null;
  age_band?: string | null;
  sex?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  created_at?: string | null;
  admission_diagnosis?: string | null;
}

interface Row {
  t: number;
  sr: number | null;
  suppressed: boolean;
  seizure: number | null;
  depth: number | null;
  sef95: number | null;
}

const CONTEXT_LABELS: Record<string, string> = {
  general_anaesthesia: "General anaesthesia",
  icu_sedation: "ICU sedation",
  procedural_sedation: "Procedural sedation",
  other: "Other",
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toRows(epochs: EpochRow[]): Row[] {
  return epochs.map((e) => ({
    t: num(e.t_offset_seconds) ?? 0,
    sr: num(e.suppression_ratio),
    suppressed: Boolean(e.is_suppressed),
    seizure: num(e.seizure_score),
    depth: num(e.depth_index),
    sef95: num(e.spectral_edge_95),
  }));
}

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable for PDF export");
  return { canvas, ctx };
}

/** Whole-session DSA rendered to a standalone bitmap with its own axes. */
function renderDsa(spectra: number[][], times: number[], w: number, h: number): string {
  const { canvas, ctx } = makeCanvas(w, h);
  const margin = { top: 14, right: 20, bottom: 34, left: 62 };
  const plotW = Math.max(1, w - margin.left - margin.right);
  const plotH = Math.max(1, h - margin.top - margin.bottom);

  ctx.fillStyle = "rgb(8,16,34)";
  ctx.fillRect(0, 0, w, h);

  const tStart = times[0] ?? 0;
  const tEnd = times[times.length - 1] ?? tStart + 1;
  const span = Math.max(1, tEnd - tStart);

  if (spectra.some((s) => s.length)) {
    paintDsaHeatmap(
      ctx,
      { x: margin.left, y: margin.top, w: plotW, h: plotH },
      (px) => {
        const t = tStart + (px / Math.max(1, plotW - 1)) * span;
        let lo = 0;
        let hi = times.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((times[mid] ?? 0) < t) lo = mid + 1;
          else hi = mid;
        }
        const before = Math.max(0, lo - 1);
        const tA = times[before] ?? t;
        const tB = times[lo] ?? tA;
        const f = tB > tA ? Math.max(0, Math.min(1, (t - tA) / (tB - tA))) : 0;
        if (lo !== before && spansGap(tA, tB)) return { lo: undefined, hi: undefined, f: 0 };
        const loSpec = spectra[before];
        const hiSpec = spectra[lo];
        return {
          lo: loSpec && loSpec.length ? loSpec : undefined,
          hi: hiSpec && hiSpec.length ? hiSpec : undefined,
          f,
        };
      },
      -6,
      26,
    );
  }

  const yForHz = (f: number) =>
    margin.top + plotH - ((f - DSA_MIN_HZ) / (DSA_MAX_HZ - DSA_MIN_HZ)) * plotH;

  ctx.strokeStyle = "rgba(255,255,255,0.20)";
  ctx.lineWidth = 1;
  ctx.strokeRect(margin.left, margin.top, plotW, plotH);

  ctx.font = "16px monospace";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  for (const f of [1, 5, 10, 15, 20, 25, 30]) {
    if (f < DSA_MIN_HZ || f > DSA_MAX_HZ) continue;
    const y = yForHz(f);
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();
    ctx.fillText(String(f), margin.left - 6, y);
  }

  ctx.save();
  ctx.translate(11, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.font = "600 16px sans-serif";
  ctx.fillText("Frequency (Hz)", 0, 0);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "16px monospace";
  for (let i = 0; i <= 6; i++) {
    const frac = i / 6;
    const x = margin.left + frac * plotW;
    ctx.textAlign = i === 0 ? "left" : i === 6 ? "right" : "center";
    ctx.fillText(formatClock(tStart + frac * span), x, margin.top + plotH + 8);
  }
  return canvas.toDataURL("image/png");
}

/** Suppression ratio trace with suppressed epochs shaded underneath. */
function renderSuppression(rows: Row[], w: number, h: number): string {
  const { canvas, ctx } = makeCanvas(w, h);
  const margin = { top: 14, right: 20, bottom: 34, left: 62 };
  const plotW = Math.max(1, w - margin.left - margin.right);
  const plotH = Math.max(1, h - margin.top - margin.bottom);

  ctx.fillStyle = "rgb(8,16,34)";
  ctx.fillRect(0, 0, w, h);

  const tStart = rows[0]?.t ?? 0;
  const tEnd = rows[rows.length - 1]?.t ?? tStart + 1;
  const span = Math.max(1, tEnd - tStart);
  const xFor = (t: number) => margin.left + ((t - tStart) / span) * plotW;
  const yFor = (sr: number) => margin.top + plotH - (Math.max(0, Math.min(100, sr)) / 100) * plotH;

  // Shaded bands where the epoch was scored as suppressed.
  ctx.fillStyle = "rgba(240,110,40,0.35)";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.suppressed) continue;
    const next = rows[i + 1]?.t ?? r.t + 1;
    const x0 = xFor(r.t);
    const x1 = xFor(next);
    ctx.fillRect(x0, margin.top, Math.max(1, x1 - x0), plotH);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "16px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of [0, 25, 50, 75, 100]) {
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();
    ctx.fillText(`${v}`, margin.left - 6, y);
  }

  ctx.strokeStyle = "rgb(250,190,30)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (const r of rows) {
    if (r.sr == null) {
      started = false;
      continue;
    }
    const x = xFor(r.t);
    const y = yFor(r.sr);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.20)";
  ctx.lineWidth = 1;
  ctx.strokeRect(margin.left, margin.top, plotW, plotH);

  ctx.save();
  ctx.translate(11, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.textAlign = "center";
  ctx.font = "600 16px sans-serif";
  ctx.fillText("Suppression ratio (%)", 0, 0);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "16px monospace";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  for (let i = 0; i <= 6; i++) {
    const frac = i / 6;
    ctx.textAlign = i === 0 ? "left" : i === 6 ? "right" : "center";
    ctx.fillText(formatClock(tStart + frac * span), margin.left + frac * plotW, margin.top + plotH + 8);
  }
  return canvas.toDataURL("image/png");
}

/** Seizure score trace with detected ictal runs marked. */
function renderSeizure(rows: Row[], events: EventRow[], w: number, h: number): string {
  const { canvas, ctx } = makeCanvas(w, h);
  const margin = { top: 14, right: 20, bottom: 34, left: 62 };
  const plotW = Math.max(1, w - margin.left - margin.right);
  const plotH = Math.max(1, h - margin.top - margin.bottom);

  ctx.fillStyle = "rgb(8,16,34)";
  ctx.fillRect(0, 0, w, h);

  const tStart = rows[0]?.t ?? 0;
  const tEnd = rows[rows.length - 1]?.t ?? tStart + 1;
  const span = Math.max(1, tEnd - tStart);
  const xFor = (t: number) => margin.left + ((Math.max(tStart, Math.min(tEnd, t)) - tStart) / span) * plotW;
  const yFor = (v: number) => margin.top + plotH - Math.max(0, Math.min(1, v)) * plotH;

  ctx.fillStyle = "rgba(220,45,55,0.35)";
  for (const e of events) {
    if (e.kind !== "seizure") continue;
    const t0 = num(e.t_offset_seconds) ?? 0;
    const dur = num(e.duration_seconds) ?? 5;
    const x0 = xFor(t0);
    const x1 = xFor(t0 + dur);
    ctx.fillRect(x0, margin.top, Math.max(2, x1 - x0), plotH);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "16px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();
    ctx.fillText(v.toFixed(2), margin.left - 8, y);
  }

  ctx.strokeStyle = "rgb(56,214,175)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (const r of rows) {
    if (r.seizure == null) {
      started = false;
      continue;
    }
    const x = xFor(r.t);
    const y = yFor(r.seizure);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.20)";
  ctx.lineWidth = 1;
  ctx.strokeRect(margin.left, margin.top, plotW, plotH);

  ctx.save();
  ctx.translate(11, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.textAlign = "center";
  ctx.font = "600 16px sans-serif";
  ctx.fillText("Seizure score", 0, 0);
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "16px monospace";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  for (let i = 0; i <= 6; i++) {
    const frac = i / 6;
    ctx.textAlign = i === 0 ? "left" : i === 6 ? "right" : "center";
    ctx.fillText(formatClock(tStart + frac * span), margin.left + frac * plotW, margin.top + plotH + 8);
  }
  return canvas.toDataURL("image/png");
}

/** Narrow colour key strip for the DSA palette. */
function renderPalette(w: number, h: number): string {
  const { canvas, ctx } = makeCanvas(w, h);
  for (let x = 0; x < w; x++) {
    const [r, g, b] = dsaColor(x / Math.max(1, w - 1), 0, 1);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, 0, 1, h);
  }
  void DSA_STOPS;
  return canvas.toDataURL("image/png");
}

function summarise(rows: Row[]) {
  const cadence =
    rows.length > 1 ? Math.max(0.1, (rows[rows.length - 1]!.t - rows[0]!.t) / (rows.length - 1)) : 1;
  const srVals = rows.map((r) => r.sr).filter((v): v is number => v != null);
  const depth = rows.map((r) => r.depth).filter((v): v is number => v != null);
  const sef = rows.map((r) => r.sef95).filter((v): v is number => v != null);
  const seiz = rows.map((r) => r.seizure).filter((v): v is number => v != null);
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const suppressedSeconds = rows.filter((r) => r.suppressed).length * cadence;
  const duration = rows.length ? rows[rows.length - 1]!.t : 0;
  return {
    duration,
    cadence,
    suppressedSeconds,
    suppressedFraction: duration > 0 ? suppressedSeconds / duration : 0,
    meanSr: mean(srVals),
    maxSr: srVals.length ? Math.max(...srVals) : null,
    meanDepth: mean(depth),
    minDepth: depth.length ? Math.min(...depth) : null,
    meanSef: mean(sef),
    maxSeizure: seiz.length ? Math.max(...seiz) : null,
  };
}

/** Contiguous runs of suppressed epochs, used for the episode table. */
export function suppressionEpisodes(rows: Row[], cadence: number) {
  const out: { start: number; end: number; duration: number; peakSr: number | null }[] = [];
  let run: { start: number; end: number; peak: number | null } | null = null;
  for (const r of rows) {
    if (r.suppressed) {
      if (!run) run = { start: r.t, end: r.t + cadence, peak: r.sr };
      else {
        run.end = r.t + cadence;
        if (r.sr != null) run.peak = Math.max(run.peak ?? r.sr, r.sr);
      }
    } else if (run) {
      out.push({ start: run.start, end: run.end, duration: run.end - run.start, peakSr: run.peak });
      run = null;
    }
  }
  if (run) out.push({ start: run.start, end: run.end, duration: run.end - run.start, peakSr: run.peak });
  return out;
}

export interface SessionReportInput {
  session: ReportSessionMeta;
  epochs: EpochRow[];
  events: EventRow[];
  /** Extra footer note, e.g. active COEBIS model description. */
  modelNote?: string;
}

/** Build the report and return the jsPDF document. */
export function buildSessionReportPdf(input: SessionReportInput): jsPDF {
  const { session, epochs, events } = input;
  const rows = toRows(epochs);
  const times = rows.map((r) => r.t);
  const spectra = epochs.map((e) =>
    Array.isArray(e.spectrum) ? (e.spectrum as unknown[]).map((v) => Number(v)) : [],
  );
  const s = summarise(rows);
  const episodes = suppressionEpisodes(rows, s.cadence);
  const seizures = events.filter((e) => e.kind === "seizure");

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 12;
  const contentW = pageW - M * 2;

  const heading = (text: string, y: number) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(20, 20, 30);
    doc.text(text, M, y);
  };
  const body = (text: string, x: number, y: number, size = 9) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    doc.setTextColor(45, 45, 60);
    doc.text(text, x, y);
  };

  // ---- Page 1: header, summary, DSA -------------------------------------
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(15, 20, 40);
  doc.text(`EEG session report — ${session.case_code ?? "unlabelled case"}`, M, M + 5);
  body(
    `Anonymised record · ${session.device_name ?? "Muse 2"} frontal EEG · generated ${new Date().toLocaleString()} · decision support only, not a diagnostic device.`,
    M,
    M + 11,
    8,
  );

  const started = session.started_at ?? session.created_at ?? null;
  const meta: [string, string][] = [
    ["Context", CONTEXT_LABELS[session.context ?? "other"] ?? String(session.context ?? "—")],
    ["Location", session.location || "—"],
    [
      "Age / sex",
      `${session.age_years ? `${session.age_years} y` : session.age_band ? `${session.age_band} y` : "—"} · ${
        session.sex && session.sex !== "unknown" ? session.sex : "—"
      }`,
    ],
    ["Started", started ? new Date(started).toLocaleString() : "—"],
    ["Ended", session.ended_at ? new Date(session.ended_at).toLocaleString() : "—"],
    ["Monitored time", formatClock(s.duration)],
  ];
  let y = M + 20;
  const colW = contentW / 3;
  meta.forEach(([label, value], i) => {
    const x = M + (i % 3) * colW;
    const rowY = y + Math.floor(i / 3) * 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(110, 115, 130);
    doc.text(label.toUpperCase(), x, rowY);
    body(value, x, rowY + 4.5, 9);
  });
  y += 24;

  heading("Case summary", y);
  y += 5;
  const stats: [string, string][] = [
    ["Mean suppression ratio", s.meanSr == null ? "—" : `${s.meanSr.toFixed(1)} %`],
    ["Peak suppression ratio", s.maxSr == null ? "—" : `${s.maxSr.toFixed(0)} %`],
    [
      "Suppression time",
      `${formatDuration(s.suppressedSeconds)} (${(s.suppressedFraction * 100).toFixed(1)} % of case)`,
    ],
    ["Suppression episodes", String(episodes.length)],
    ["Mean depth index", s.meanDepth == null ? "—" : s.meanDepth.toFixed(0)],
    ["Lowest depth index", s.minDepth == null ? "—" : s.minDepth.toFixed(0)],
    ["Mean SEF95", s.meanSef == null ? "—" : `${s.meanSef.toFixed(1)} Hz`],
    ["Seizure detections", `${seizures.length} (peak score ${s.maxSeizure?.toFixed(2) ?? "—"})`],
  ];
  const sColW = contentW / 4;
  stats.forEach(([label, value], i) => {
    const x = M + (i % 4) * sColW;
    const rowY = y + Math.floor(i / 4) * 11;
    doc.setDrawColor(220, 224, 232);
    doc.roundedRect(x, rowY, sColW - 3, 9, 1.2, 1.2);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.setTextColor(110, 115, 130);
    doc.text(label.toUpperCase(), x + 2, rowY + 3.4);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(25, 28, 40);
    doc.text(value, x + 2, rowY + 7.6);
  });
  y += 26;

  heading("Whole-case density spectral array", y);
  y += 3;
  const plotH = pageH - y - M - 6;
  if (spectra.some((sp) => sp.length)) {
    const img = renderDsa(spectra, times, 1800, Math.round((1800 * plotH) / contentW));
    doc.addImage(img, "PNG", M, y, contentW, plotH);
  } else {
    body("No spectral data stored for this case.", M, y + 8);
  }
  const paletteW = 34;
  doc.addImage(renderPalette(400, 12), "PNG", pageW - M - paletteW, y - 3.4, paletteW, 2.2);
  body("power  low", pageW - M - paletteW - 20, y - 1.9, 6.5);
  body("high", pageW - M + 0.5, y - 1.9, 6.5);


  // ---- Page 2: suppression + seizure ------------------------------------
  doc.addPage();
  let y2 = M + 5;
  heading("Burst-suppression timeline", y2);
  body(
    `Shaded bands mark epochs scored as suppressed. Suppression time ${formatDuration(
      s.suppressedSeconds,
    )} · mean SR ${s.meanSr == null ? "—" : `${s.meanSr.toFixed(1)} %`} · peak SR ${
      s.maxSr == null ? "—" : `${s.maxSr.toFixed(0)} %`
    }`,
    M,
    y2 + 5,
    8,
  );
  y2 += 9;
  const chartH = 48;
  if (rows.length) {
    doc.addImage(
      renderSuppression(rows, 1800, Math.round((1800 * chartH) / contentW)),
      "PNG",
      M,
      y2,
      contentW,
      chartH,
    );
  }
  y2 += chartH + 8;

  heading("Seizure score and detected ictal runs", y2);
  y2 += 4;
  if (rows.length) {
    doc.addImage(
      renderSeizure(rows, events, 1800, Math.round((1800 * chartH) / contentW)),
      "PNG",
      M,
      y2,
      contentW,
      chartH,
    );
  }
  y2 += chartH + 10;

  // Tables of episodes and seizures side by side.
  const tableW = contentW / 2 - 4;
  const drawTable = (
    x: number,
    top: number,
    title: string,
    header: string[],
    body_: string[][],
    empty: string,
  ) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(20, 20, 30);
    doc.text(title, x, top);
    let ty = top + 5;
    const cw = tableW / header.length;
    doc.setFontSize(7);
    doc.setTextColor(110, 115, 130);
    header.forEach((hd, i) => doc.text(hd.toUpperCase(), x + i * cw, ty));
    ty += 1.5;
    doc.setDrawColor(220, 224, 232);
    doc.line(x, ty, x + tableW, ty);
    ty += 4;
    doc.setFontSize(8.5);
    doc.setTextColor(40, 42, 55);
    if (!body_.length) {
      doc.setTextColor(120, 124, 138);
      doc.text(empty, x, ty);
      return;
    }
    const maxRows = Math.floor((pageH - M - ty) / 5);
    for (const r of body_.slice(0, maxRows)) {
      r.forEach((cell, i) => doc.text(cell, x + i * cw, ty));
      ty += 5;
    }
    if (body_.length > maxRows) {
      doc.setTextColor(120, 124, 138);
      doc.text(`+ ${body_.length - maxRows} more not shown`, x, ty);
    }
  };

  drawTable(
    M,
    y2,
    "Suppression episodes",
    ["Onset", "Duration", "Peak SR"],
    episodes.map((e) => [
      formatClock(e.start),
      formatDuration(e.duration),
      e.peakSr == null ? "—" : `${e.peakSr.toFixed(0)} %`,
    ]),
    "No suppression episodes detected.",
  );
  drawTable(
    M + contentW / 2 + 4,
    y2,
    "Detected seizure activity",
    ["Onset", "Duration", "Severity"],
    seizures.map((e) => [
      formatClock(num(e.t_offset_seconds) ?? 0),
      formatDuration(num(e.duration_seconds) ?? 0),
      String(e.severity ?? "—"),
    ]),
    "No ictal-appearing events detected.",
  );

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(130, 134, 146);
    doc.text(
      `${session.case_code ?? "case"} · ${input.modelNote ?? "CortexTrace"} · page ${p} of ${pages}`,
      M,
      pageH - 5,
    );
  }
  return doc;
}

/** Suggested filename for a case export. */
export function reportFileName(session: ReportSessionMeta): string {
  const code = (session.case_code ?? "case").replace(/[^A-Za-z0-9_-]+/g, "-");
  return `${code}-eeg-report.pdf`;
}

/** One-click download of the session report. */
export function downloadSessionReportPdf(input: SessionReportInput) {
  const doc = buildSessionReportPdf(input);
  doc.save(reportFileName(input.session));
}
