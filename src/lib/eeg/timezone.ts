import { useCallback, useEffect, useState } from "react";

/**
 * Case timestamps are always *stored* as UTC instants (Postgres `timestamptz`,
 * serialised as ISO-8601). This module only changes how those instants are
 * *displayed*; nothing here ever rewrites a stored value.
 */
export const STORAGE_TIME_ZONE = "UTC";

const KEY = "eeg.timeZone.v1";
const EVENT = "eeg-timezone-change";

/** "device" follows the browser/OS zone; anything else is an IANA zone name. */
export type TimeZonePreference = "device" | (string & {});

export const DEVICE_ZONE_LABEL = "Device time";

/** Common theatre/ICU zones offered in the picker, alongside the device zone and UTC. */
export const COMMON_TIME_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
] as const;

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || STORAGE_TIME_ZONE;
  } catch {
    return STORAGE_TIME_ZONE;
  }
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Resolve a preference to a concrete IANA zone usable by Intl. */
export function resolveTimeZone(pref: TimeZonePreference): string {
  if (pref === "device") return deviceTimeZone();
  return isValidTimeZone(pref) ? pref : deviceTimeZone();
}

export function readTimeZonePreference(): TimeZonePreference {
  if (typeof window === "undefined") return "device";
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw || raw === "device") return "device";
    return isValidTimeZone(raw) ? raw : "device";
  } catch {
    return "device";
  }
}

export function writeTimeZonePreference(pref: TimeZonePreference) {
  try {
    window.localStorage.setItem(KEY, pref);
  } catch {
    /* private mode — display preference is best-effort */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Short zone name for the badge, e.g. "BST", "GMT+2", "UTC". */
export function timeZoneAbbreviation(zone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      timeZoneName: "short",
    }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone;
  }
}

/** Current UTC offset of a zone, e.g. "UTC+01:00". */
export function timeZoneOffsetLabel(zone: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    return raw.replace("GMT", "UTC") === "UTC" ? "UTC+00:00" : raw.replace("GMT", "UTC");
  } catch {
    return "UTC+00:00";
  }
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date and time of day in the chosen zone, e.g. "6 Aug 2026, 09:12". */
export function formatStampInZone(
  value: string | number | Date | null | undefined,
  zone: string,
): string {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleString("en-GB", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Time of day only, in the chosen zone. */
export function formatTimeInZone(
  value: string | number | Date | null | undefined,
  zone: string,
  withSeconds = false,
): string {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleTimeString("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

/** Start stamp with the finish time appended when known, e.g. "6 Aug 2026, 09:12 – 10:46". */
export function formatRangeInZone(
  startValue: string | number | Date | null | undefined,
  endValue: string | number | Date | null | undefined,
  zone: string,
): string {
  const start = formatStampInZone(startValue, zone);
  if (start === "—" || endValue == null) return start;
  const end = formatTimeInZone(endValue, zone);
  return end === "—" ? start : `${start} – ${end}`;
}

/**
 * Timezone used for *displaying* stored case timestamps. Stored values stay in
 * UTC; switching here only changes presentation, and the choice is shared
 * across every mounted view on this device.
 */
export function useTimeZonePreference() {
  const [preference, setPreference] = useState<TimeZonePreference>("device");
  const [zone, setZone] = useState<string>(STORAGE_TIME_ZONE);

  useEffect(() => {
    const sync = () => {
      const pref = readTimeZonePreference();
      setPreference(pref);
      setZone(resolveTimeZone(pref));
    };
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((next: TimeZonePreference) => {
    writeTimeZonePreference(next);
    setPreference(next);
    setZone(resolveTimeZone(next));
  }, []);

  return {
    /** Raw preference: "device" or an IANA zone. */
    preference,
    /** Concrete IANA zone to pass to the formatters. */
    zone,
    /** Short label, e.g. "BST". */
    abbreviation: timeZoneAbbreviation(zone),
    /** Offset label, e.g. "UTC+01:00". */
    offsetLabel: timeZoneOffsetLabel(zone),
    setPreference: update,
  };
}
