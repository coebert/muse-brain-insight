import type { AnalysisSettings, DetectedEvent } from "@/lib/eeg/analysis";
import type { AlarmSide } from "@/lib/eeg/alarms";
import type { Alarm } from "@/hooks/useAlarms";
import type { DepthWindowPrefs, DepthWindowStatus } from "@/hooks/useDepthWindowAlerts";
import type { TciInfusion } from "@/lib/eeg/tci";

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
    alarms: Alarm[];
    unacknowledged: Alarm[];
    audioEnabled: boolean;
    muted: boolean;
    muteRemaining: number;
    acknowledge: (id: string) => void;
    acknowledgeAll: () => void;
    acknowledgeSide: (side: AlarmSide) => void;
    pauseAudio: () => void;
    resumeAudio: () => void;
    setAudioEnabled: (on: boolean) => void;
  };

  /** Live readings shown beside the limits so a value can be judged in context. */
  live: {
    depthIndex: number | null;
    suppressionRatio: number | null;
    seizureScore: number | null;
    sqi: number | null;
  };
}
