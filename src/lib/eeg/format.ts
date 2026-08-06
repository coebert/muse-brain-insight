export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} min ${s.toString().padStart(2, "0")} s`;
}

/** Wall-clock case length in seconds (end minus start); null when it cannot be derived. */
export function caseDurationSeconds(
  startedAt: string | number | Date | null | undefined,
  endedAt: string | number | Date | null | undefined,
): number | null {
  if (startedAt == null || endedAt == null) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

/** Human case length, e.g. "1 h 34 min" / "12 min". */
export function formatCaseDuration(
  startedAt: string | number | Date | null | undefined,
  endedAt: string | number | Date | null | undefined,
): string {
  const seconds = caseDurationSeconds(startedAt, endedAt);
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds} s`;
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h} h ${m.toString().padStart(2, "0")} min` : `${m} min`;
}
