/**
 * Keeping the actual EEG waveform of a filed case.
 *
 * The live archive only ever lived in memory, so a saved case could be
 * reviewed as a DSA and a set of numbers but never as the signal itself. The
 * samples are decimated to {@link RAW_ARCHIVE_HZ} already, so one case is a
 * few megabytes; they are stored as 16-bit integers with a per-chunk
 * microvolt scale, base64 encoded, in five-minute blocks per electrode.
 */

import { supabase } from "@/integrations/supabase/client";
import { createRawArchive, RAW_ARCHIVE_HZ, type RawArchive } from "@/lib/eeg/raw-archive";

/** Seconds of signal held in one stored block, per electrode. */
export const RAW_CHUNK_SECONDS = 300;

const INT16_MAX = 32767;

export function encodeChunk(samples: Float32Array): { base64: string; scaleUv: number } {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] as number);
    if (v > peak) peak = v;
  }
  const scaleUv = peak > 0 ? peak / INT16_MAX : 1 / INT16_MAX;
  const ints = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const q = Math.round((samples[i] as number) / scaleUv);
    ints[i] = Math.max(-INT16_MAX, Math.min(INT16_MAX, q));
  }
  return { base64: bytesToBase64(new Uint8Array(ints.buffer)), scaleUv };
}

export function decodeChunk(base64: string, scaleUv: number): Float32Array {
  const bytes = base64ToBytes(base64);
  const ints = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const out = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) out[i] = (ints[i] as number) * scaleUv;
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * File the waveform of a case that has just been saved. Best effort by
 * design: the case record itself is already written, so a failure here must
 * never lose the case.
 */
export async function saveSessionRawTraces(
  sessionId: string,
  userId: string,
  archive: RawArchive,
  channels: string[],
): Promise<{ channels: number; seconds: number }> {
  let stored = 0;
  let longest = 0;
  for (const channel of channels) {
    const end = archive.duration(channel);
    // Only the tail of a long case is still in memory; everything older has
    // fallen out of the ring and would be filed as hours of silence.
    const begin = archive.retainedFrom(channel);
    const duration = end - begin;
    if (duration < 1) continue;
    longest = Math.max(longest, duration);
    const rows: {
      session_id: string;
      user_id: string;
      channel: string;
      chunk_index: number;
      start_seconds: number;
      sample_rate: number;
      sample_count: number;
      scale_uv: number;
      samples_base64: string;
    }[] = [];
    let index = 0;
    for (let from = begin; from < end; from += RAW_CHUNK_SECONDS) {
      const to = Math.min(end, from + RAW_CHUNK_SECONDS);
      const samples = archive.read(channel, from, to);
      if (!samples.length) {
        index++;
        continue;
      }
      const { base64, scaleUv } = encodeChunk(samples);
      rows.push({
        session_id: sessionId,
        user_id: userId,
        channel,
        chunk_index: index++,
        start_seconds: Number((from - begin).toFixed(3)),
        sample_rate: RAW_ARCHIVE_HZ,
        sample_count: samples.length,
        scale_uv: scaleUv,
        samples_base64: base64,
      });
    }
    if (!rows.length) continue;
    // Small groups: each row is ~100 kB, so one giant insert can be rejected
    // on a poor theatre connection, but one row at a time keeps the clinician
    // waiting far longer than necessary at the end of a case.
    const CONCURRENCY = 4;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map((row) => supabase.from("session_raw_chunks").insert(row)),
      );
      for (const { error } of results) if (error) throw error;
    }
    stored++;
  }
  return { channels: stored, seconds: longest };
}

export interface StoredRawTraces {
  archive: RawArchive;
  channels: string[];
  /** Longest electrode duration in seconds. */
  span: number;
  sampleRate: number;
}

/** Rebuild an in-memory archive for a filed case, ready for the trace viewer. */
export async function loadSessionRawTraces(sessionId: string): Promise<StoredRawTraces | null> {
  const { data, error } = await supabase
    .from("session_raw_chunks")
    .select("channel, chunk_index, start_seconds, sample_rate, sample_count, scale_uv, samples_base64")
    .eq("session_id", sessionId)
    .order("channel", { ascending: true })
    .order("chunk_index", { ascending: true });
  if (error) throw error;
  if (!data?.length) return null;

  const archive = createRawArchive();
  const channels: string[] = [];
  let span = 0;
  let sampleRate = RAW_ARCHIVE_HZ;
  for (const row of data) {
    const rate = Number(row.sample_rate) || RAW_ARCHIVE_HZ;
    sampleRate = rate;
    const samples = decodeChunk(row.samples_base64, Number(row.scale_uv));
    if (!channels.includes(row.channel)) channels.push(row.channel);
    // Push at the stored rate so the archive keeps it 1:1 (no decimation).
    archive.push(row.channel, samples, rate);
    span = Math.max(span, Number(row.start_seconds) + samples.length / rate);
  }
  return { archive, channels, span, sampleRate };
}
