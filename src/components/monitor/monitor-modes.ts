import { HeartPulse, Stethoscope } from "lucide-react";

export type MonitorMode = "anaesthesia" | "icu";

export interface MonitorModeConfig {
  key: MonitorMode;
  label: string;
  icon: typeof Stethoscope;
  blurb: string;
  /** Detection preset applied when the mode is selected. */
  presetKey: string;
  /** Clinical context stored with the anonymised case record. */
  context: string;
}

export const MODES: MonitorModeConfig[] = [
  {
    key: "anaesthesia",
    label: "Anaesthesia",
    icon: Stethoscope,
    blurb:
      "Continuous DSA with spectral edge, suppression ratio and suppression time up front. Seizure detection runs conservatively in the background.",
    presetKey: "anaesthesia",
    context: "general_anaesthesia",
  },
  {
    key: "icu",
    label: "ICU",
    icon: HeartPulse,
    blurb:
      "Seizure- and burst-suppression-led: sensitive ictal alerting, longer suppression window, seizure score and suppression burden shown first.",
    presetKey: "icu",
    context: "icu_sedation",
  },
];

export function modeConfig(mode: MonitorMode): MonitorModeConfig {
  return MODES.find((m) => m.key === mode) ?? MODES[0]!;
}

/** DSA window (minutes) that suits each mode's pace of change. */
export function defaultWindowMinutes(mode: MonitorMode): number {
  return mode === "icu" ? 30 : 10;
}