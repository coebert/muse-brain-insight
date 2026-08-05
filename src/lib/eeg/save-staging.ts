/**
 * Crash/network resilience for saving a finished case.
 *
 * A completed anaesthetic record must not be lost because the theatre Wi-Fi
 * dropped at the moment the clinician pressed save. The payload is staged in
 * localStorage before the first write and only cleared once every insert has
 * succeeded, so an interrupted save can be retried from the next screen.
 */

export const STAGED_SAVE_KEY = "eeg.session.pendingSave";

export interface StagedSave<T = unknown> {
  /** When the save was first attempted (ISO). */
  stagedAt: string;
  /** Case code as typed, for the "unsaved case" prompt. */
  label: string;
  payload: T;
}

export function stageSave<T>(label: string, payload: T) {
  if (typeof window === "undefined") return;
  try {
    const record: StagedSave<T> = { stagedAt: new Date().toISOString(), label, payload };
    window.localStorage.setItem(STAGED_SAVE_KEY, JSON.stringify(record));
  } catch {
    // Storage full or unavailable — the in-memory save still proceeds.
  }
}

export function readStagedSave<T = unknown>(): StagedSave<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STAGED_SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StagedSave<T>;
    return parsed && typeof parsed.stagedAt === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function clearStagedSave() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STAGED_SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Retry a write a few times with exponential backoff. Only transient failures
 * are worth retrying; a permission or validation error will fail identically
 * every time, so the caller decides via `shouldRetry`.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  {
    attempts = 3,
    baseDelayMs = 400,
    shouldRetry = () => true,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: {
    attempts?: number;
    baseDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await op();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) break;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/** Network/timeout style failures are worth another go; policy errors are not. */
export function isTransient(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String((error as { message?: string })?.message ?? "")
  ).toLowerCase();
  if (!message) return true;
  if (/permission|denied|violates|duplicate|invalid|unauthor|not null/.test(message)) return false;
  return true;
}
