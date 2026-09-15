/**
 * A local, on-disk spool of the raw EEG, written while the case is running.
 *
 * Until now the waveform only existed in memory until the case was filed, so
 * a headband that dropped and never came back — or a tab that was closed,
 * reloaded or crashed — took the signal with it. The samples are now written
 * to the browser's own storage (IndexedDB) every few seconds as the case runs,
 * in the same 16-bit encoding used for filed cases, so the waveform survives
 * independently of the connection and of the page.
 *
 * Nothing here talks to the server: it is a local safety net that can later be
 * attached to a saved case or downloaded.
 */

import { encodeChunk } from "@/lib/eeg/raw-trace-store";
import { RAW_ARCHIVE_HZ, type RawArchive } from "@/lib/eeg/raw-archive";

const DB_NAME = "coebis-raw-spool";
const DB_VERSION = 1;
const SPOOLS = "spools";
const CHUNKS = "chunks";

/** Seconds of signal in one spooled block, per electrode. */
export const SPOOL_CHUNK_SECONDS = 20;
/** How often the spool is topped up from the live archive. */
export const SPOOL_FLUSH_MS = 10_000;
/** Spools older than this are dropped, so storage cannot grow without bound. */
export const SPOOL_RETENTION_DAYS = 14;

export interface SpoolMeta {
  /** Capture key of the running stream — stable across reconnects. */
  id: string;
  device: string;
  channels: string[];
  startedAt: number;
  updatedAt: number;
  /** Case code, once the clinician has started a case. */
  caseCode: string | null;
  /** Session id, once the spool has been attached to a filed case. */
  attachedSessionId: string | null;
  seconds: number;
  bytes: number;
}

export interface SpoolChunk {
  spoolId: string;
  channel: string;
  startSeconds: number;
  sampleRate: number;
  sampleCount: number;
  scaleUv: number;
  base64: string;
}

/**
 * Which stretches of a channel still need writing. Kept pure and separate so
 * the block boundaries can be checked without a browser database.
 */
export function planFlush(
  writtenTo: number,
  retainedFrom: number,
  duration: number,
  chunkSeconds = SPOOL_CHUNK_SECONDS,
): { from: number; to: number }[] {
  // Anything that has already fallen out of the ring can never be recovered,
  // so resume from the oldest sample still held rather than replaying silence.
  let from = Math.max(writtenTo, retainedFrom);
  const blocks: { from: number; to: number }[] = [];
  while (duration - from >= chunkSeconds) {
    blocks.push({ from, to: from + chunkSeconds });
    from += chunkSeconds;
  }
  return blocks;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SPOOLS)) db.createObjectStore(SPOOLS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CHUNKS)) {
        const store = db.createObjectStore(CHUNKS, { autoIncrement: true });
        store.createIndex("spool", "spoolId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listLocalSpools(): Promise<SpoolMeta[]> {
  if (!idbAvailable()) return [];
  const db = await openDb();
  try {
    const tx = db.transaction(SPOOLS, "readonly");
    const rows = await request(tx.objectStore(SPOOLS).getAll() as IDBRequest<SpoolMeta[]>);
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  } finally {
    db.close();
  }
}

export async function readLocalSpool(spoolId: string): Promise<SpoolChunk[]> {
  if (!idbAvailable()) return [];
  const db = await openDb();
  try {
    const tx = db.transaction(CHUNKS, "readonly");
    const index = tx.objectStore(CHUNKS).index("spool");
    const rows = await request(index.getAll(spoolId) as IDBRequest<SpoolChunk[]>);
    return rows.sort(
      (a, b) => a.channel.localeCompare(b.channel) || a.startSeconds - b.startSeconds,
    );
  } finally {
    db.close();
  }
}

export async function deleteLocalSpool(spoolId: string): Promise<void> {
  if (!idbAvailable()) return;
  const db = await openDb();
  try {
    const tx = db.transaction([SPOOLS, CHUNKS], "readwrite");
    tx.objectStore(SPOOLS).delete(spoolId);
    const index = tx.objectStore(CHUNKS).index("spool");
    const keys = await request(index.getAllKeys(spoolId));
    for (const key of keys) tx.objectStore(CHUNKS).delete(key);
    await done(tx);
  } finally {
    db.close();
  }
}

export async function markSpoolAttached(spoolId: string, sessionId: string): Promise<void> {
  await updateMeta(spoolId, (meta) => ({ ...meta, attachedSessionId: sessionId }));
}

export async function markSpoolCase(spoolId: string, caseCode: string): Promise<void> {
  await updateMeta(spoolId, (meta) => ({ ...meta, caseCode }));
}

async function updateMeta(spoolId: string, fn: (meta: SpoolMeta) => SpoolMeta): Promise<void> {
  if (!idbAvailable()) return;
  const db = await openDb();
  try {
    const tx = db.transaction(SPOOLS, "readwrite");
    const store = tx.objectStore(SPOOLS);
    const meta = await request(store.get(spoolId) as IDBRequest<SpoolMeta | undefined>);
    if (meta) store.put(fn(meta));
    await done(tx);
  } finally {
    db.close();
  }
}

/** Drop spools older than the retention window, and any attached to a case. */
export async function pruneLocalSpools(nowMs = Date.now()): Promise<number> {
  const cutoff = nowMs - SPOOL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const spools = await listLocalSpools();
  let removed = 0;
  for (const spool of spools) {
    if (spool.startedAt < cutoff) {
      await deleteLocalSpool(spool.id);
      removed++;
    }
  }
  return removed;
}

export interface LocalRawSpool {
  /** Begin (or resume) spooling the archive under this key. */
  open: (meta: { id: string; device: string; channels: string[]; caseCode?: string | null }) => void;
  /** Write everything the archive holds that has not been spooled yet. */
  flush: () => Promise<void>;
  /** Stop spooling; the written blocks stay on disk. */
  close: () => void;
  currentId: () => string | null;
}

/**
 * Spool writer over a live {@link RawArchive}. Failures are swallowed: a full
 * or blocked local store must never interrupt a case.
 */
export function createLocalRawSpool(archive: RawArchive): LocalRawSpool {
  let spoolId: string | null = null;
  let device = "";
  let channels: string[] = [];
  let caseCode: string | null = null;
  let startedAt = 0;
  const writtenTo = new Map<string, number>();
  let flushing = false;

  return {
    open(meta) {
      if (spoolId === meta.id) {
        if (meta.caseCode) caseCode = meta.caseCode;
        return;
      }
      spoolId = meta.id;
      device = meta.device;
      channels = meta.channels;
      caseCode = meta.caseCode ?? null;
      startedAt = Date.now();
      writtenTo.clear();
    },
    close() {
      spoolId = null;
      writtenTo.clear();
    },
    currentId: () => spoolId,
    async flush() {
      if (!spoolId || flushing || !idbAvailable()) return;
      flushing = true;
      const id = spoolId;
      try {
        const pending: SpoolChunk[] = [];
        let seconds = 0;
        let bytes = 0;
        for (const channel of channels) {
          const duration = archive.duration(channel);
          seconds = Math.max(seconds, duration);
          const blocks = planFlush(
            writtenTo.get(channel) ?? 0,
            archive.retainedFrom(channel),
            duration,
          );
          for (const block of blocks) {
            const samples = archive.read(channel, block.from, block.to);
            if (samples.length) {
              const { base64, scaleUv } = encodeChunk(samples);
              bytes += base64.length;
              pending.push({
                spoolId: id,
                channel,
                startSeconds: Number(block.from.toFixed(3)),
                sampleRate: RAW_ARCHIVE_HZ,
                sampleCount: samples.length,
                scaleUv,
                base64,
              });
            }
            writtenTo.set(channel, block.to);
          }
        }
        if (!pending.length && writtenTo.size) return;
        const db = await openDb();
        try {
          const tx = db.transaction([SPOOLS, CHUNKS], "readwrite");
          const chunkStore = tx.objectStore(CHUNKS);
          for (const chunk of pending) chunkStore.add(chunk);
          const spoolStore = tx.objectStore(SPOOLS);
          const existing = await request(spoolStore.get(id) as IDBRequest<SpoolMeta | undefined>);
          spoolStore.put({
            id,
            device,
            channels,
            startedAt: existing?.startedAt ?? startedAt,
            updatedAt: Date.now(),
            caseCode: caseCode ?? existing?.caseCode ?? null,
            attachedSessionId: existing?.attachedSessionId ?? null,
            seconds: Math.max(seconds, existing?.seconds ?? 0),
            bytes: (existing?.bytes ?? 0) + bytes,
          } satisfies SpoolMeta);
          await done(tx);
        } finally {
          db.close();
        }
      } catch {
        // Local storage is a safety net; never surface its failures mid-case.
      } finally {
        flushing = false;
      }
    },
  };
}
