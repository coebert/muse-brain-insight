import { describe, expect, it } from "vitest";

import { describeLiveStatus } from "./ActiveCaseBar";

const base = {
  caseRunning: true,
  hasUnfiledData: true,
  reconnectAttempt: null,
  dataGapSeconds: 0,
  sourceName: "Muse-1A2B",
  epochs: 12,
};

describe("describeLiveStatus", () => {
  it("says recording when a running case is streaming cleanly", () => {
    const s = describeLiveStatus({ ...base, status: "streaming" });
    expect(s.label).toBe("Recording");
    expect(s.tone).toBe("live");
  });

  it("names the reconnect attempt while the link is down", () => {
    const s = describeLiveStatus({
      ...base,
      status: "reconnecting",
      reconnectAttempt: { attempt: 2, attempts: 5 },
    });
    expect(s.label).toBe("Reconnecting");
    expect(s.detail).toContain("2 of 5");
    expect(s.tone).toBe("bad");
  });

  it("flags a connected link that has stopped delivering samples", () => {
    const s = describeLiveStatus({ ...base, status: "streaming", dataGapSeconds: 7 });
    expect(s.label).toBe("Connected · no data");
    expect(s.detail).toBe("gap 7s");
  });

  it("separates connected-but-not-started from recording", () => {
    const s = describeLiveStatus({ ...base, status: "streaming", caseRunning: false });
    expect(s.label).toBe("Connected");
  });

  it("reports an ended, unfiled case", () => {
    const s = describeLiveStatus({ ...base, status: "idle", caseRunning: false });
    expect(s.label).toBe("Case ended");
    expect(s.detail).toBe("not filed yet");
  });
});
