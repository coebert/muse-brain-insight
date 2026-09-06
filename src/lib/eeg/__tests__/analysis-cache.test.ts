import { describe, expect, it } from "vitest";

import {
  ANALYSIS_JOBS,
  claimExpired,
  describeAge,
  emptyCached,
  FRESH_FOR_MINUTES,
  isAnalysisJob,
  isStale,
} from "@/lib/eeg/analysis-cache";

const now = new Date("2026-01-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

describe("analysis job registry", () => {
  it("recognises known job keys and rejects unknown ones", () => {
    expect(isAnalysisJob("suppression-dashboard")).toBe(true);
    expect(isAnalysisJob("not-a-job")).toBe(false);
  });

  it("has no duplicate keys", () => {
    expect(new Set(ANALYSIS_JOBS).size).toBe(ANALYSIS_JOBS.length);
  });
});

describe("freshness", () => {
  it("treats a never-computed result as stale", () => {
    expect(isStale(null, now)).toBe(true);
  });

  it("keeps a recent result current", () => {
    expect(isStale(minutesAgo(FRESH_FOR_MINUTES - 5), now)).toBe(false);
  });

  it("ages a result out past the window", () => {
    expect(isStale(minutesAgo(FRESH_FOR_MINUTES + 5), now)).toBe(true);
  });
});

describe("claims", () => {
  it("holds a fresh claim so a second pass stands down", () => {
    expect(claimExpired(minutesAgo(1), now)).toBe(false);
  });

  it("releases an abandoned claim", () => {
    expect(claimExpired(minutesAgo(30), now)).toBe(true);
    expect(claimExpired(null, now)).toBe(true);
  });
});

describe("describeAge", () => {
  it("reads in plain words", () => {
    expect(describeAge(null, now)).toBe("not worked out yet");
    expect(describeAge(minutesAgo(0), now)).toBe("just now");
    expect(describeAge(minutesAgo(1), now)).toBe("1 minute ago");
    expect(describeAge(minutesAgo(20), now)).toBe("20 minutes ago");
    expect(describeAge(minutesAgo(60), now)).toBe("1 hour ago");
    expect(describeAge(minutesAgo(60 * 5), now)).toBe("5 hours ago");
    expect(describeAge(minutesAgo(60 * 72), now)).toBe("3 days ago");
  });
});

describe("emptyCached", () => {
  it("starts queued, empty and stale", () => {
    const empty = emptyCached("bis-benchmark");
    expect(empty.status).toBe("queued");
    expect(empty.payload).toBeNull();
    expect(empty.stale).toBe(true);
    expect(empty.rowsScanned).toBe(0);
  });
});
