/// <reference types="web-bluetooth" />
/**
 * End-to-end activation check.
 *
 * One tap: choose the band, survey it, send every documented activation
 * sequence variant, and answer a single question — did notifications start
 * within the deadline, and which sequence started them?
 *
 * Everything it needs already exists in `ble-identify.ts`; this module fixes
 * the settings that make the run a *test* rather than an exploration (probe
 * on, early exit as soon as the band streams, hard 60-second budget) and turns
 * the survey into a pass/fail verdict with the firmware's own reply codes.
 */

import {
  describeAck,
  identifyBleHeadset,
  type BleFirmwareAck,
  type BleIdentifyReport,
} from "@/lib/eeg/ble-identify";

/** Default budget from first byte written to first notification received. */
export const ACTIVATION_DEADLINE_SECONDS = 60;

export type ActivationOutcome = "streaming-eeg" | "streaming-unreadable" | "silent" | "rejected";

export interface ActivationCheckResult {
  outcome: ActivationOutcome;
  /** True when notifications began inside the deadline. */
  passed: boolean;
  deadlineSeconds: number;
  /** Seconds from the start of the run to the first notification. */
  timeToFirstPacketSeconds: number | null;
  /** Sequence variant that made the band talk, when one did. */
  activatedByVariant: string | null;
  /** Exact command inside that variant. */
  activatedByStep: string | null;
  /** Firmware error codes seen, attributed to the command that caused them. */
  errors: BleFirmwareAck[];
  summary: string;
  advice: string;
  report: BleIdentifyReport;
}

export interface ActivationCheckOptions {
  /** Total budget for the check. Default 60 seconds. */
  deadlineSeconds?: number;
  /** Reuse an already-chosen device instead of opening the chooser. */
  device?: BluetoothDevice;
  onProgress?: (message: string) => void;
  /** Fires as each firmware acknowledgement is decoded, for live display. */
  onAck?: (ack: BleFirmwareAck) => void;
}

/**
 * Runs the whole flow and reports whether the band streamed within the budget.
 * Only a failure to open the link throws; a band that stays silent is a result,
 * not an error.
 */
export async function runActivationCheck(
  options: ActivationCheckOptions = {},
): Promise<ActivationCheckResult> {
  const deadlineSeconds = Math.min(
    180,
    Math.max(10, options.deadlineSeconds ?? ACTIVATION_DEADLINE_SECONDS),
  );

  const report = await identifyBleHeadset({
    watchSeconds: deadlineSeconds,
    probeActivation: true,
    stopWhenStreaming: true,
    stopProbeWhenStreaming: true,
    ...(options.device ? { device: options.device } : {}),
    onProgress: options.onProgress ?? (() => {}),
    onAck: options.onAck ?? (() => {}),
  });

  return summariseActivationCheck(report, deadlineSeconds);
}

/** Turns a completed survey into the activation verdict. */
export function summariseActivationCheck(
  report: BleIdentifyReport,
  deadlineSeconds = ACTIVATION_DEADLINE_SECONDS,
): ActivationCheckResult {
  const errors = report.acks.filter((ack) => !ack.ok);
  const packets = report.characteristics.reduce((sum, entry) => sum + entry.packets, 0);
  const eeg = report.characteristics.some((entry) => (entry.bestScore ?? 0) >= 0.6);
  const timeToFirstPacketSeconds =
    report.timeToFirstPacketMs == null
      ? null
      : Number((report.timeToFirstPacketMs / 1000).toFixed(1));
  const inTime =
    timeToFirstPacketSeconds != null && timeToFirstPacketSeconds <= deadlineSeconds;

  // Acknowledgement frames are notifications too, so an explicit firmware
  // rejection outranks "packets arrived" — otherwise a refused pairing looks
  // like an undecodable stream.
  const outcome: ActivationOutcome = eeg
    ? "streaming-eeg"
    : errors.length
      ? "rejected"
      : packets > 0
        ? "streaming-unreadable"
        : "silent";

  const via = report.activatedByVariant
    ? ` Sequence "${report.activatedByVariant}" (${report.activatedByStep}) started the stream.`
    : "";

  let summary: string;
  let advice: string;
  switch (outcome) {
    case "streaming-eeg":
      summary = `Activation passed: notifications began after ${timeToFirstPacketSeconds}s and decoded as EEG.${via}`;
      advice = "The band is ready — start a case or the stream test.";
      break;
    case "streaming-unreadable":
      summary = `Activation started a stream after ${timeToFirstPacketSeconds}s, but the packets did not decode as EEG.${via}`;
      advice =
        "Export this report: the captured packet bytes are what is needed to work out the payload layout.";
      break;
    case "rejected":
      summary = `The band answered but refused to start within ${deadlineSeconds}s: ${errors
        .slice(0, 3)
        .map(describeAck)
        .join("; ")}.`;
      advice = errors.some((ack) => (ack.sysResult ?? "").includes("PAIR"))
        ? "The firmware rejected the pairing identity. Forget the band in the Bluetooth settings of this browser and device, power-cycle it, then run the check again."
        : "The firmware rejected the activation commands. Export this report so the failing command and its code can be matched against the vendor protocol.";
      break;
    default:
      summary = `No notifications at all within ${deadlineSeconds}s, despite every documented activation sequence being sent.`;
      advice =
        "Make sure the FocusCalm app is fully closed, the charging cable is unplugged and the band is in pairing mode, then run the check again.";
  }

  return {
    outcome,
    passed: outcome === "streaming-eeg" && inTime,
    deadlineSeconds,
    timeToFirstPacketSeconds,
    activatedByVariant: report.activatedByVariant ?? null,
    activatedByStep: report.activatedByStep ?? null,
    errors,
    summary,
    advice,
    report,
  };
}
