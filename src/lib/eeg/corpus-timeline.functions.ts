/**
 * File an uploaded corpus recording as a case on the timeline.
 *
 * The training pool and the timeline serve different purposes: the pool holds
 * labelled epochs for grading and priors, the timeline holds cases a clinician
 * can open and review. An uploaded night belongs in both, but it must never be
 * mistaken for a bedside recording, so the case code is prefixed and the
 * device name states the collection it came from.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const Reading = z.object({
  atSeconds: z.number(),
  depthIndex: z.number().nullable(),
  suppressionRatio: z.number(),
  isSuppressed: z.boolean(),
  sef95: z.number(),
  totalPower: z.number(),
  bands: z.record(z.string(), z.number()),
  spectrumDb: z.array(z.number()),
  label: z.string().nullable(),
});

const Input = z.object({
  caseRef: z.string().min(1).max(60),
  corpusId: z.string().min(1).max(60),
  corpusLabel: z.string().min(1).max(120),
  channel: z.string().min(1).max(40),
  sampleRate: z.number().positive(),
  readings: z.array(Reading).min(1).max(6000),
});

export interface CorpusTimelineResult {
  sessionId: string;
  caseCode: string;
  epochs: number;
}

/** Cap on stored readings so a whole night stays a reviewable case. */
const MAX_EPOCHS = 5000;

function thin<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]!);
  return out;
}

export const fileCorpusTimeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data, context }): Promise<CorpusTimelineResult> => {
    const { supabase, userId } = context;
    const readings = thin(
      [...data.readings].sort((a, b) => a.atSeconds - b.atSeconds),
      MAX_EPOCHS,
    );

    const srs = readings.map((r) => r.suppressionRatio);
    const meanSr = srs.reduce((a, b) => a + b, 0) / srs.length;
    const maxSr = srs.reduce((a, b) => Math.max(a, b), 0);
    const lastAt = readings[readings.length - 1]!.atSeconds;
    const caseCode = `COR-${data.caseRef.toUpperCase().slice(0, 24)}`;

    const { data: session, error } = await supabase
      .from("eeg_sessions")
      .insert({
        user_id: userId,
        case_code: caseCode,
        context: "other",
        notes: `Uploaded from ${data.corpusLabel} · channel ${data.channel} · ${Math.round(
          data.sampleRate,
        )} Hz. Depth values are this app's own estimate; the collection publishes none.`,
        device_name: `corpus:${data.corpusId}`,
        started_at: new Date().toISOString(),
        ended_at: new Date(Date.now() + lastAt * 1000).toISOString(),
        duration_seconds: Math.round(lastAt),
        mean_suppression_ratio: Number(meanSr.toFixed(2)),
        max_suppression_ratio: Number(maxSr.toFixed(2)),
        suppression_seconds: readings.filter((r) => r.isSuppressed).length,
        seizure_alerts: 0,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    const sessionId = (session as { id: string }).id;

    let inserted = 0;
    for (let i = 0; i < readings.length; i += 200) {
      const chunk = readings.slice(i, i + 200).map((r) => ({
        session_id: sessionId,
        user_id: userId,
        t_offset_seconds: r.atSeconds,
        suppression_ratio: r.suppressionRatio,
        is_suppressed: r.isSuppressed,
        seizure_score: 0,
        total_power: r.totalPower,
        spectral_edge_95: r.sef95,
        bands: r.bands,
        power_ratios: {},
        spectrum: r.spectrumDb,
        depth_index: r.depthIndex,
      }));
      const { error: insertError } = await supabase.from("eeg_epochs").insert(chunk as never);
      if (insertError) throw new Error(insertError.message);
      inserted += chunk.length;
    }

    return { sessionId, caseCode, epochs: inserted };
  });
