import { useSyncExternalStore } from "react";

import type { WaveformStore } from "@/lib/eeg/waveform-store";

import { WaveformStrip } from "./WaveformStrip";

interface Props {
  store: WaveformStore;
  suppressionThresholdUv: number;
  suppressed: boolean;
}

/**
 * Draws the live trace by subscribing directly to the waveform store, so the
 * 5 Hz refresh redraws the canvas without re-rendering the dashboard around it.
 */
export function LiveWaveform({ store, suppressionThresholdUv, suppressed }: Props) {
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <WaveformStrip
      data={data}
      suppressionThresholdUv={suppressionThresholdUv}
      suppressed={suppressed}
    />
  );
}
