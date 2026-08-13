import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Low-battery watch for the paired Muse 2. The threshold is a device-level
 * clinician preference; crossing it latches a banner and (optionally) raises a
 * browser notification so a flat headband never quietly ends a case.
 */

const KEY = "eeg.batteryAlert.v1";

export const BATTERY_THRESHOLD_CHOICES = [10, 15, 20, 25, 30, 40, 50] as const;
export const DEFAULT_BATTERY_THRESHOLD = 20;
/** Charge must climb this far back above the threshold before re-arming. */
const REARM_MARGIN = 5;
/** While still low, remind at most this often. */
const REPEAT_MS = 10 * 60 * 1000;

export interface BatteryAlertPrefs {
  threshold: number;
  notify: boolean;
}

function read(): BatteryAlertPrefs {
  const fallback: BatteryAlertPrefs = { threshold: DEFAULT_BATTERY_THRESHOLD, notify: false };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<BatteryAlertPrefs>;
    const threshold = Number(parsed.threshold);
    return {
      threshold: Number.isFinite(threshold) ? Math.min(90, Math.max(5, Math.round(threshold))) : fallback.threshold,
      notify: parsed.notify === true,
    };
  } catch {
    return fallback;
  }
}

function write(prefs: BatteryAlertPrefs) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode) — preference is best-effort */
  }
}

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Watches the reported charge against the configured threshold and returns the
 * banner state plus the controls needed to tune it.
 */
export function useBatteryAlert(percent: number | null, connected: boolean) {
  const [prefs, setPrefs] = useState<BatteryAlertPrefs>({
    threshold: DEFAULT_BATTERY_THRESHOLD,
    notify: false,
  });
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    "unsupported",
  );
  const [dismissed, setDismissed] = useState(false);
  const armed = useRef(true);
  const lastNotifiedAt = useRef(0);

  useEffect(() => {
    setPrefs(read());
    if (notificationsSupported()) setPermission(Notification.permission);
  }, []);

  const low = percent != null && percent <= prefs.threshold;
  const critical = percent != null && percent <= Math.min(10, prefs.threshold);

  // Re-arm once the headband has been charged back above the threshold.
  useEffect(() => {
    if (percent != null && percent >= prefs.threshold + REARM_MARGIN) {
      armed.current = true;
      lastNotifiedAt.current = 0;
      setDismissed(false);
    }
  }, [percent, prefs.threshold]);

  // Raise a browser notification on each fresh crossing, then remind sparingly.
  useEffect(() => {
    if (!low || percent == null) return;
    if (!prefs.notify || !notificationsSupported() || Notification.permission !== "granted") return;
    const now = Date.now();
    const fresh = armed.current;
    if (!fresh && now - lastNotifiedAt.current < REPEAT_MS) return;
    armed.current = false;
    lastNotifiedAt.current = now;
    try {
      new Notification("Muse 2 battery low", {
        body: `Headband charge is ${percent}% (alert at ${prefs.threshold}%). Charge or swap before it stops streaming.`,
        tag: "cortextrace-battery",
        requireInteraction: percent <= 10,
      });
    } catch {
      /* notification blocked by the browser — the banner still shows */
    }
  }, [low, percent, prefs.notify, prefs.threshold]);

  const setThreshold = useCallback((threshold: number) => {
    setPrefs((prev) => {
      const next = { ...prev, threshold };
      write(next);
      return next;
    });
    armed.current = true;
    setDismissed(false);
  }, []);

  const setNotify = useCallback(async (notify: boolean) => {
    if (notify && notificationsSupported() && Notification.permission === "default") {
      try {
        setPermission(await Notification.requestPermission());
      } catch {
        /* permission prompt unavailable */
      }
    } else if (notificationsSupported()) {
      setPermission(Notification.permission);
    }
    setPrefs((prev) => {
      const next = { ...prev, notify };
      write(next);
      return next;
    });
  }, []);

  return {
    threshold: prefs.threshold,
    setThreshold,
    notify: prefs.notify,
    setNotify,
    permission,
    /** Charge is at or below the configured threshold. */
    low,
    critical,
    /** Banner should be on screen right now. */
    visible: low && !dismissed,
    connected,
    percent,
    dismiss: () => setDismissed(true),
  };
}
