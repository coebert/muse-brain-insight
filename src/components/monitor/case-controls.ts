import type { AnalysisSettings, DetectedEvent } from "@/lib/eeg/analysis";
import type { AlarmSide } from "@/lib/eeg/alarms";
import type { ActiveAlarm } from "@/hooks/useAlarms";
import type { DepthWindowPrefs, DepthWindowStatus } from "@/hooks/useDepthWindowAlerts";
import type { TciInfusion } from "@/lib/eeg/tci";
import type { BisReading } from "@/lib/eeg/bis";
import type { CaseMeta } from "@/lib/eeg/case-meta";

/**
 * Everything a clinician can touch during a live case, gathered into one
 * object so the dashboard and the full-screen bedside monitor render exactly
 * the same controls from a single source of truth.
 */
export interface CaseControls {
  running: boolean;
  elapsed: number;
  mode: "anaesthesia" | "icu";

  /** Record a marker, optionally back-dated by `backdateSeconds`. */
  onMark: (label: string, backdateSeconds?: number) => void;
  markers: DetectedEvent[];
  /** Full session timeline (detections plus clinician markers). */
  events: DetectedEvent[];

  infusions: TciInfusion[];
  onInfusionsChange: (next: TciInfusion[]) => void;

  /** Values transcribed from a commercial BIS monitor running alongside. */
  bisReadings: BisReading[];
  onBisReadingsChange: (next: BisReading[]) => void;

  /** Live case details, so notes and the free-text summary can be written mid-case. */
  caseNotes?: { meta: CaseMeta; onChange: (next: CaseMeta) => void };

  settings: AnalysisSettings;
  onSettingsChange: (patch: Partial<AnalysisSettings>, description: string) => void;
  /** True when limits differ from the current mode's defaults. */
  limitsOffDefault: boolean;
  onResetLimits: () => void;

  depthWindow: {
    prefs: DepthWindowPrefs;
    setPrefs: (next: Partial<DepthWindowPrefs>) => void;
    status: DepthWindowStatus;
    breachSeconds: number;
  };

  sqi: { threshold: number; setThreshold: (next: number) => void };

  alarms: {
    alarms: ActiveAlarm[];
    unacknowledged: ActiveAlarm[];
    audioEnabled: boolean;
    muted: boolean;
    muteRemaining: number;
    acknowledge: (id: string) => void;
    acknowledgeAll: () => void;
    acknowledgeSide: (side: AlarmSide) => void;
    unacknowledge: (id: string) => void;
    pauseAudio: () => void;
    resumeAudio: () => void;
    setAudioEnabled: (on: boolean) => void;
  };

  /** Dimmed display for darkened theatres. */
  dim: boolean;
  onDimChange: (next: boolean) => void;

  /** One-screen "what has happened so far" for handover. */
  handover: { label: string; value: string }[];

  /** Live readings shown beside the limits so a value can be judged in context. */
  live: {
    depthIndex: number | null;
    suppressionRatio: number | null;
    seizureScore: number | null;
    sqi: number | null;
  };
}
