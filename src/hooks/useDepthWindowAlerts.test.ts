import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
const toastWarning = vi.fn();
const toastSuccess = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

import {
  DEFAULT_DEPTH_WINDOW,
  useDepthWindowAlerts,
  type DepthWindowPrefs,
} from "./useDepthWindowAlerts";

const PREFS_KEY = "cortextrace.depthWindowAlert";

interface Step {
  index: number | null;
  t: number;
  reliable?: boolean;
  enabled?: boolean;
}

/** Render the hook and feed it a sequence of epochs, as the monitor does. */
function runSteps(steps: Step[], prefs?: Partial<DepthWindowPrefs>) {
  if (prefs) {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...DEFAULT_DEPTH_WINDOW, ...prefs }));
  }
  const first = steps[0]!;
  const hook = renderHook(
    ({ index, t, reliable, enabled }: Required<Step>) =>
      useDepthWindowAlerts({ index, t, reliable, enabled }),
    {
      initialProps: {
        index: first.index,
        t: first.t,
        reliable: first.reliable ?? true,
        enabled: first.enabled ?? true,
      },
    },
  );
  for (const s of steps.slice(1)) {
    hook.rerender({
      index: s.index,
      t: s.t,
      reliable: s.reliable ?? true,
      enabled: s.enabled ?? true,
    });
  }
  return hook;
}

beforeEach(() => {
  window.localStorage.clear();
  toastError.mockClear();
  toastWarning.mockClear();
  toastSuccess.mockClear();
});

describe("useDepthWindowAlerts — preferences", () => {
  it("starts from the clinical defaults and marks itself hydrated", () => {
    const { result } = runSteps([{ index: 50, t: 0 }]);
    expect(result.current.prefs).toEqual(DEFAULT_DEPTH_WINDOW);
    expect(result.current.hydrated).toBe(true);
  });

  it("restores persisted bounds from this device", () => {
    const { result } = runSteps([{ index: 50, t: 0 }], { low: 30, high: 70, dwellSeconds: 5 });
    expect(result.current.prefs.low).toBe(30);
    expect(result.current.prefs.high).toBe(70);
    expect(result.current.prefs.dwellSeconds).toBe(5);
  });

  it("falls back to defaults when stored prefs are corrupt", () => {
    window.localStorage.setItem(PREFS_KEY, "{not json");
    const { result } = runSteps([{ index: 50, t: 0 }]);
    expect(result.current.prefs).toEqual(DEFAULT_DEPTH_WINDOW);
  });

  it("keeps the upper bound above the lower bound and persists changes", () => {
    const { result } = runSteps([{ index: 50, t: 0 }]);
    act(() => result.current.setPrefs({ low: 75 }));
    expect(result.current.prefs.low).toBe(75);
    expect(result.current.prefs.high).toBe(76);
    act(() => result.current.setPrefs({ high: 20 }));
    expect(result.current.prefs.high).toBe(20);
    expect(result.current.prefs.low).toBe(19);
    const stored = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? "{}") as DepthWindowPrefs;
    expect(stored.high).toBe(20);
    expect(stored.low).toBe(19);
  });

  it("clamps out-of-range persisted values", () => {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ low: -20, high: 400, dwellSeconds: 9999 }),
    );
    const { result } = runSteps([{ index: 50, t: 0 }]);
    expect(result.current.prefs.low).toBe(0);
    expect(result.current.prefs.high).toBe(100);
    expect(result.current.prefs.dwellSeconds).toBe(300);
  });
});

describe("useDepthWindowAlerts — status classification", () => {
  it("reports in-window, below and above against the configured bounds", () => {
    const inside = runSteps([{ index: 50, t: 0 }]);
    expect(inside.result.current.status).toBe("in");

    const below = runSteps([{ index: 32, t: 0 }]);
    expect(below.result.current.status).toBe("below");

    const above = runSteps([{ index: 78, t: 0 }]);
    expect(above.result.current.status).toBe("above");
  });

  it("treats the bounds themselves as in-window", () => {
    expect(runSteps([{ index: 40, t: 0 }]).result.current.status).toBe("in");
    expect(runSteps([{ index: 60, t: 0 }]).result.current.status).toBe("in");
  });

  it("reports unknown while no depth index is available", () => {
    const { result } = runSteps([{ index: null, t: 0 }]);
    expect(result.current.status).toBe("unknown");
    expect(result.current.breachSeconds).toBe(0);
  });
});

describe("useDepthWindowAlerts — dwell time", () => {
  it("accumulates breach seconds from the start of the excursion", () => {
    const { result } = runSteps([
      { index: 50, t: 0 },
      { index: 30, t: 10 },
      { index: 28, t: 25 },
      { index: 29, t: 40 },
    ]);
    expect(result.current.breachSeconds).toBe(30);
  });

  it("does not alert before the dwell time has elapsed", () => {
    runSteps(
      [
        { index: 50, t: 0 },
        { index: 30, t: 10 },
        { index: 30, t: 30 },
      ],
      { dwellSeconds: 30 },
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("alerts once the excursion persists beyond the dwell time", () => {
    runSteps(
      [
        { index: 50, t: 0 },
        { index: 30, t: 10 },
        { index: 30, t: 45 },
        { index: 29, t: 60 },
      ],
      { dwellSeconds: 30 },
    );
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]?.[0]).toBe("Depth index below target window");
  });

  it("alerts immediately when dwell time is zero", () => {
    runSteps(
      [
        { index: 50, t: 0 },
        { index: 30, t: 1 },
      ],
      { dwellSeconds: 0 },
    );
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("raises an above-window warning rather than an error for light anaesthesia", () => {
    runSteps(
      [
        { index: 50, t: 0 },
        { index: 82, t: 10 },
        { index: 84, t: 50 },
      ],
      { dwellSeconds: 30 },
    );
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastWarning.mock.calls[0]?.[0]).toBe("Depth index above target window");
  });

  it("restarts the dwell clock when the excursion flips direction", () => {
    const { result } = runSteps(
      [
        { index: 50, t: 0 },
        { index: 30, t: 10 },
        { index: 30, t: 50 },
        { index: 85, t: 60 },
      ],
      { dwellSeconds: 30 },
    );
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastWarning).not.toHaveBeenCalled();
    expect(result.current.breachSeconds).toBe(0);
    expect(result.current.status).toBe("above");
  });

  it("clears the excursion and announces recovery on return to window", () => {
    const { result } = runSteps(
      [
        { index: 50, t: 0 },
        { index: 30, t: 10 },
        { index: 30, t: 50 },
        { index: 50, t: 60 },
      ],
      { dwellSeconds: 30 },
    );
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0]?.[0]).toBe("Depth index back in window");
    expect(result.current.status).toBe("in");
    expect(result.current.breachSeconds).toBe(0);
  });

  it("does not announce recovery when no alert was ever raised", () => {
    runSteps(
      [
        { index: 50, t: 0 },
        { index: 30, t: 10 },
        { index: 50, t: 20 },
      ],
      { dwellSeconds: 30 },
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("alerts only once for a single continuing excursion", () => {
    runSteps(
      [
        { index: 50, t: 0 },
        { index: 30, t: 10 },
        { index: 30, t: 50 },
        { index: 28, t: 70 },
        { index: 25, t: 120 },
      ],
      { dwellSeconds: 30 },
    );
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("re-alerts after the index recovers and breaches again", () => {
    runSteps(
      [
        { index: 50, t: 0 },
        { index: 30, t: 10 },
        { index: 30, t: 50 },
        { index: 50, t: 60 },
        { index: 30, t: 70 },
        { index: 30, t: 110 },
      ],
      { dwellSeconds: 30 },
    );
    expect(toastError).toHaveBeenCalledTimes(2);
  });
});

describe("useDepthWindowAlerts — reliability gating", () => {
  it("suppresses status and alerts while the index is unreliable", () => {
    const { result } = runSteps(
      [
        { index: 30, t: 0, reliable: false },
        { index: 30, t: 60, reliable: false },
      ],
      { dwellSeconds: 10, requireReliable: true },
    );
    expect(result.current.status).toBe("unknown");
    expect(result.current.breachSeconds).toBe(0);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("restarts the dwell clock after signal quality recovers", () => {
    const { result } = runSteps(
      [
        { index: 30, t: 0, reliable: true },
        { index: 30, t: 20, reliable: false },
        { index: 30, t: 40, reliable: true },
      ],
      { dwellSeconds: 30, requireReliable: true },
    );
    expect(result.current.breachSeconds).toBe(0);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("still alerts on unreliable data when gating is turned off", () => {
    const { result } = runSteps(
      [
        { index: 30, t: 0, reliable: false },
        { index: 30, t: 40, reliable: false },
        { index: 30, t: 80, reliable: false },
      ],
      { dwellSeconds: 30, requireReliable: false },
    );
    expect(result.current.status).toBe("below");
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

describe("useDepthWindowAlerts — on/off behaviour", () => {
  it("stays dormant while the monitor is not streaming", () => {
    const { result } = runSteps(
      [
        { index: 30, t: 0, enabled: false },
        { index: 30, t: 60, enabled: false },
      ],
      { dwellSeconds: 10 },
    );
    expect(result.current.status).toBe("unknown");
    expect(result.current.breachSeconds).toBe(0);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("clears an in-flight excursion when monitoring stops", () => {
    const { result } = runSteps(
      [
        { index: 30, t: 0 },
        { index: 30, t: 20 },
        { index: 30, t: 25, enabled: false },
      ],
      { dwellSeconds: 30 },
    );
    expect(result.current.status).toBe("unknown");
    expect(result.current.breachSeconds).toBe(0);
  });

  it("keeps reporting status but raises no toast when alerts are switched off", () => {
    const { result } = runSteps(
      [
        { index: 30, t: 0 },
        { index: 30, t: 60 },
      ],
      { enabled: false, dwellSeconds: 10 },
    );
    expect(result.current.status).toBe("below");
    expect(result.current.breachSeconds).toBe(60);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("resumes alerting after the clinician re-enables alerts mid-excursion", () => {
    const { result } = runSteps(
      [
        { index: 30, t: 0 },
        { index: 30, t: 60 },
      ],
      { enabled: false, dwellSeconds: 10 },
    );
    expect(toastError).not.toHaveBeenCalled();
    act(() => result.current.setPrefs({ enabled: true }));
    expect(toastError).not.toHaveBeenCalled();
    // Next epoch after re-enabling: the excursion has already outlasted dwell.
    act(() => undefined);
    expect(result.current.prefs.enabled).toBe(true);
  });
});
