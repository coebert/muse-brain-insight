/**
 * Server functions for the continuous capture path.
 *
 * The monitor calls {@link captureBatch} every few seconds while a recording
 * runs, so the readings survive a closed tab, a flat battery, or a case that
 * was never filed. Everything written here is already anonymised.
 */

import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { CaptureBatch, CaptureStats, CaptureSummaryRow } from "@/lib/eeg/auto-capture";

interface BatchInput extends CaptureBatch {}

export const captureBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: BatchInput) => {
    if (!input || typeof input.captureKey !== "string" || !input.captureKey)
      throw new Error("A capture key is required.");
    if (!Array.isArray(input.epochs)) throw new Error("Epochs must be an array.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: existing } = await supabase
      .from("capture_sessions")
      .select("id, epoch_count")
      .eq("user_id", userId)
      .eq("capture_key", data.captureKey)
      .maybeSingle();

    let captureId = (existing as { id?: string } | null)?.id ?? null;
    if (!captureId) {
      const { data: created, error } = await supabase
        .from("capture_sessions")
        .insert({
          user_id: userId,
          capture_key: data.captureKey,
          started_at: data.startedAt,
          device_name: data.deviceName,
          montage: data.montage,
          sample_rate: data.sampleRate,
          lineage_key: data.lineageKey,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      captureId = (created as { id: string }).id;
    }

    if (data.epochs.length) {
      const rows = data.epochs.map((e) => ({
        capture_id: captureId,
        user_id: userId,
        epoch_index: e.epochIndex,
        at_seconds: e.atSeconds,
        recorded_at: e.recordedAt,
        depth_index: e.depthIndex,
        sef95: e.sef95,
        suppression_ratio: e.suppressionRatio,
        epoch_suppression: e.epochSuppression,
        total_power: e.totalPower,
        amplitude_uv: e.amplitudeUv,
        sqi: e.sqi,
        quality_grade: e.qualityGrade,
        artifact: e.artifact,
        bands: e.bands,
        ratios: e.ratios,
        spectrum: e.spectrum,
      }));
      // Re-sending a window after a dropped response must not duplicate it.
      const { error } = await supabase
        .from("capture_epochs")
        .upsert(rows as never, { onConflict: "capture_id,epoch_index" });
      if (error) throw new Error(error.message);
    }

    const { count } = await supabase
      .from("capture_epochs")
      .select("id", { count: "exact", head: true })
      .eq("capture_id", captureId);

    await supabase
      .from("capture_sessions")
      .update({
        last_seen_at: new Date().toISOString(),
        epoch_count: count ?? 0,
        device_name: data.deviceName,
        montage: data.montage,
        sample_rate: data.sampleRate,
        lineage_key: data.lineageKey,
      })
      .eq("id", captureId);

    return { captureId, stored: count ?? 0 };
  });

/** Mark a capture as the recording behind a filed case. */
export const linkCaptureToSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { captureKey: string; sessionId: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("capture_sessions")
      .update({ filed_session_id: data.sessionId })
      .eq("user_id", userId)
      .eq("capture_key", data.captureKey);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Readings kept when a clinician recovers a lost recording by hand. */
export const RECOVER_MAX_EPOCHS = 7200;

/**
 * Recover a recording that was never filed — a case lost to a headband dropout
 * or a closed tab — as a case on the timeline, without waiting for the
 * scheduled pick-up. Only the derived readings exist in the capture, so the
 * recovered case has its trend, suppression and spectra but no raw waveform.
 */
export const recoverCapture = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { captureKey: string }) => {
    if (!input?.captureKey) throw new Error("A recording is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("capture_sessions")
      .select(
        "id, user_id, capture_key, started_at, device_name, epoch_count, filed_session_id, harvested_session_id",
      )
      .eq("user_id", userId)
      .eq("capture_key", data.captureKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const capture = row as Record<string, any> | null;
    if (!capture) throw new Error("That recording could not be found.");
    if (capture["filed_session_id"] || capture["harvested_session_id"])
      throw new Error("That recording is already on the timeline.");
    if (/demo|simulat|test/i.test(String(capture["device_name"] ?? "")))
      throw new Error("Test recordings are never filed as cases.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { harvestOneCapture, RECOVER_LIMIT } = await import("@/lib/eeg/capture-harvest.server");
    const done = await harvestOneCapture(supabaseAdmin as never, capture, RECOVER_LIMIT);
    if (!done) throw new Error("That recording has no readings to recover.");
    return { sessionId: done.sessionId, epochs: done.epochsCopied };
  });

export const getCaptureStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CaptureStats> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("capture_sessions")
      .select(
        "capture_key, started_at, last_seen_at, device_name, lineage_key, epoch_count, filed_session_id, harvested_session_id",
      )
      .eq("user_id", userId)
      .order("last_seen_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    const recent: CaptureSummaryRow[] = rows.map((r) => ({
      captureKey: String(r["capture_key"]),
      startedAt: String(r["started_at"]),
      lastSeenAt: String(r["last_seen_at"]),
      deviceName: (r["device_name"] as string | null) ?? null,
      lineageKey: (r["lineage_key"] as string | null) ?? null,
      epochs: Number(r["epoch_count"] ?? 0),
      filed: Boolean(r["filed_session_id"]),
      harvested: Boolean(r["harvested_session_id"]),
    }));

    const epochs = recent.reduce((a, r) => a + r.epochs, 0);
    const inPool = recent.filter((r) => r.filed || r.harvested).length;
    return {
      captures: recent.length,
      epochs,
      inPool,
      waiting: recent.length - inPool,
      hours: epochs / 3600,
      recent: recent.slice(0, 50),
    };
  });
