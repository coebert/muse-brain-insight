/**
 * Headband link log.
 *
 * When a Muse 2 drops mid-case there is nothing afterwards to look at: the
 * browser reports a bare `gattserverdisconnected` with no reason, and the
 * console is gone as soon as the tab is. This keeps a small, timestamped
 * record of every link event — attach, keep-alive failure, silence, the drop
 * itself, each reconnect attempt and its outcome — persisted to the machine so
 * it survives a reload, and exportable as text.
 *
 * It records only connection events: no EEG, no patient information.
 */

export type LinkEventKind =
  | "start"
  | "attached"
  | "battery"
  | "keepalive-failed"
  | "silent"
  | "nudge"
  | "dropped"
  | "reconnect-attempt"
  | "reconnect-ok"
  | "reconnect-failed"
  | "stopped";

export interface LinkEvent {
  at: number;
  kind: LinkEventKind;
  message: string;
  /** Seconds since the link last attached, where known. */
  uptimeSeconds?: number;
  data?: Record<string, unknown>;
}

const STORAGE_KEY = "cortextrace.muse.link-log.v1";
const MAX_EVENTS = 400;

function canStore() {
  return typeof window !== "undefined" && !!window.localStorage;
}

/** Rolling link history, shared by the Muse client and the diagnostics panel. */
export class MuseLinkLog {
  private events: LinkEvent[] = [];
  private listeners = new Set<(events: LinkEvent[]) => void>();
  private attachedAt = 0;
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!canStore()) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        this.events = parsed.filter(
          (e): e is LinkEvent =>
            !!e && typeof e === "object" && typeof (e as LinkEvent).at === "number",
        );
      }
    } catch {
      /* a corrupt log is not worth failing a case over */
    }
  }

  private persist() {
    if (!canStore()) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.events));
    } catch {
      /* quota or private mode — the in-memory log still works */
    }
  }

  /** Marks the moment the link came up, so later events carry an uptime. */
  markAttached(at = Date.now()) {
    this.attachedAt = at;
  }

  add(kind: LinkEventKind, message: string, data?: Record<string, unknown>) {
    this.load();
    const at = Date.now();
    const event: LinkEvent = { at, kind, message };
    if (this.attachedAt && kind !== "start") {
      event.uptimeSeconds = Math.round((at - this.attachedAt) / 1000);
    }
    if (data && Object.keys(data).length) event.data = data;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.persist();
    for (const cb of this.listeners) cb([...this.events]);
  }

  all(): LinkEvent[] {
    this.load();
    return [...this.events];
  }

  clear() {
    this.loaded = true;
    this.events = [];
    this.attachedAt = 0;
    this.persist();
    for (const cb of this.listeners) cb([]);
  }

  subscribe(cb: (events: LinkEvent[]) => void): () => void {
    this.load();
    this.listeners.add(cb);
    cb([...this.events]);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

export const museLinkLog = new MuseLinkLog();

/** How long each connected stretch lasted, newest last. */
export function linkUptimes(events: LinkEvent[]): { from: number; to: number; seconds: number }[] {
  const out: { from: number; to: number; seconds: number }[] = [];
  let openedAt: number | null = null;
  for (const event of events) {
    if (event.kind === "attached" || event.kind === "reconnect-ok") openedAt = event.at;
    else if ((event.kind === "dropped" || event.kind === "stopped") && openedAt !== null) {
      out.push({ from: openedAt, to: event.at, seconds: Math.round((event.at - openedAt) / 1000) });
      openedAt = null;
    }
  }
  return out;
}

/** Plain-text export, safe to paste into a message. */
export function formatLinkLog(events: LinkEvent[]): string {
  const lines = [
    "CortexTrace headband link log",
    `Exported: ${new Date().toISOString()}`,
    typeof navigator === "undefined" ? "" : `Browser: ${navigator.userAgent}`,
    `Events: ${events.length}`,
    "",
  ].filter(Boolean);
  for (const event of events) {
    const up = event.uptimeSeconds === undefined ? "" : ` (+${event.uptimeSeconds}s connected)`;
    const extra = event.data ? ` ${JSON.stringify(event.data)}` : "";
    lines.push(`${new Date(event.at).toISOString()} ${event.kind.padEnd(18)}${event.message}${up}${extra}`);
  }
  const spans = linkUptimes(events);
  if (spans.length) {
    lines.push("", "Connected stretches:");
    for (const span of spans) {
      lines.push(
        `  ${new Date(span.from).toISOString()} → ${new Date(span.to).toISOString()}  ${span.seconds}s`,
      );
    }
  }
  return lines.join("\n");
}
