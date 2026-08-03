/**
 * Bedside alarm management: IEC 60601-1-8-flavoured priorities, an audible
 * tone that keeps sounding until a clinician acknowledges, and a latch so a
 * transient event cannot vanish before anyone sees it.
 */

export type AlarmPriority = "high" | "medium" | "low";

export interface Alarm {
  /** Stable key: one alarm per condition, re-armed after acknowledgement. */
  id: string;
  priority: AlarmPriority;
  title: string;
  detail: string;
  /** Session clock, seconds, when the condition was first met. */
  t: number;
  acknowledgedAt: number | null;
}

export const PRIORITY_LABEL: Record<AlarmPriority, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Advisory",
};

/** Burst pattern per priority. */
const PATTERN: Record<AlarmPriority, { notes: number; repeatMs: number; freq: number }> = {
  high: { notes: 5, repeatMs: 5000, freq: 960 },
  medium: { notes: 3, repeatMs: 12000, freq: 660 },
  low: { notes: 1, repeatMs: 30000, freq: 480 },
};

/**
 * Web Audio tone generator. Created lazily on the first user gesture so the
 * browser autoplay policy does not block it.
 */
export class AlarmTone {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: AlarmPriority | null = null;

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx ??= new Ctor();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Plays one burst immediately, then repeats until stop() is called. */
  start(priority: AlarmPriority) {
    if (this.current === priority && this.timer) return;
    this.stop();
    this.current = priority;
    const pattern = PATTERN[priority];
    this.burst(pattern.notes, pattern.freq);
    this.timer = setInterval(() => this.burst(pattern.notes, pattern.freq), pattern.repeatMs);
  }

  private burst(notes: number, freq: number) {
    const ctx = this.ensureContext();
    if (!ctx) return;
    for (let i = 0; i < notes; i++) {
      const at = ctx.currentTime + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.15);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current = null;
  }

  /** Short confirmation blip for acknowledgements. */
  blip() {
    this.burst(1, 1200);
  }
}

export function highestPriority(alarms: Alarm[]): AlarmPriority | null {
  if (alarms.some((a) => a.priority === "high")) return "high";
  if (alarms.some((a) => a.priority === "medium")) return "medium";
  if (alarms.some((a) => a.priority === "low")) return "low";
  return null;
}
