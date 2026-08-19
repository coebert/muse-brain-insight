import { useSyncExternalStore } from "react";

import {
  getActiveDeviceProfile,
  subscribeDeviceProfile,
  type DeviceProfile,
} from "@/lib/eeg/device-profile";

/**
 * Reads the profile of the source currently feeding the analysis, so channel
 * pickers, timelines and raw viewers render the montage that actually exists
 * rather than a fixed four-electrode set.
 */
export function useDeviceProfile(): DeviceProfile {
  return useSyncExternalStore(
    subscribeDeviceProfile,
    getActiveDeviceProfile,
    getActiveDeviceProfile,
  );
}
