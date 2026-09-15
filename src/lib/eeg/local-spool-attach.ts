/**
 * Moving a locally spooled waveform into a filed case.
 *
 * The spool is written in the same encoding as {@link saveSessionRawTraces},
 * so recovering it is a matter of replaying its blocks into
 * `session_raw_chunks` under the chosen case.
 */

import { supabase } from "@/integrations/supabase/client";
import { readLocalSpool, markSpoolAttached, type SpoolChunk } from "@/lib/eeg/local-raw-spool";

/** Rows already stored for a case, so a re-run cannot duplicate the waveform. */
async function hasExistingTraces(sessionId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("session_raw_chunks")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function attachSpoolToSession(
  spoolId: string,
  sessionId: string,
  userId: string,
): Promise<{ chunks: number; seconds: number }> {
  if (await hasExistingTraces(sessionId)) {
    throw new Error("That case already has a stored waveform.");
  }
  const chunks: SpoolChunk[] = await readLocalSpool(spoolId);
  if (!chunks.length) throw new Error("This local recording holds no signal.");

  const perChannel = new Map<string, number>();
  const rows = chunks.map((chunk) => {
    const index = perChannel.get(chunk.channel) ?? 0;
    perChannel.set(chunk.channel, index + 1);
    return {
      session_id: sessionId,
      user_id: userId,
      channel: chunk.channel,
      chunk_index: index,
      start_seconds: chunk.startSeconds,
      sample_rate: chunk.sampleRate,
      sample_count: chunk.sampleCount,
      scale_uv: chunk.scaleUv,
      samples_base64: chunk.base64,
    };
  });

  const CONCURRENCY = 8;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((row) => supabase.from("session_raw_chunks").insert(row)),
    );
    for (const { error } of results) if (error) throw error;
  }
  await markSpoolAttached(spoolId, sessionId);
  const seconds = chunks.reduce(
    (max, c) => Math.max(max, c.startSeconds + c.sampleCount / c.sampleRate),
    0,
  );
  return { chunks: rows.length, seconds };
}

/** Download the spool as a single JSON file, for keeping or analysing offline. */
export async function downloadSpool(spoolId: string, label: string): Promise<void> {
  const chunks = await readLocalSpool(spoolId);
  const blob = new Blob([JSON.stringify({ spoolId, label, chunks }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${label.replace(/[^a-zA-Z0-9-]+/g, "-")}-raw-eeg.json`;
  link.click();
  URL.revokeObjectURL(url);
}
