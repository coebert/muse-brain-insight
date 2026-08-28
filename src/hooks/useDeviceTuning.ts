import { useMemo } from "react";

import { useDeviceProfile } from "@/hooks/useDeviceProfile";
import { deviceTuning, type DeviceTuning } from "@/lib/eeg/device-tuning";

/**
 * The running configuration for whichever headset is streaming — which DSA
 * layouts are renderable, whether µV thresholds are absolute, whether the
 * EMG band exists, and what the app has adapted as a result.
 */
export function useDeviceTuning(): DeviceTuning {
  const profile = useDeviceProfile();
  return useMemo(() => deviceTuning(profile), [profile]);
}
