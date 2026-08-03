import { useCallback, useEffect, useRef, useState } from "react";

export type DsaView = "bilateral" | "combined" | "overlay";

const KEY = "eeg.dsaView.v1";
const DEFAULT_VIEW: DsaView = "bilateral";

type Store = { device: DsaView; cases: Record<string, DsaView> };

function isView(v: unknown): v is DsaView {
  return v === "bilateral" || v === "combined" || v === "overlay";
}

function read(): Store {
  if (typeof window === "undefined") return { device: DEFAULT_VIEW, cases: {} };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { device: DEFAULT_VIEW, cases: {} };
    const parsed = JSON.parse(raw) as Partial<Store>;
    const cases: Record<string, DsaView> = {};
    for (const [k, v] of Object.entries(parsed.cases ?? {})) if (isView(v)) cases[k] = v;
    return { device: isView(parsed.device) ? parsed.device : DEFAULT_VIEW, cases };
  } catch {
    return { device: DEFAULT_VIEW, cases: {} };
  }
}

function write(store: Store) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* storage unavailable (private mode) — preference is best-effort */
  }
}

const caseKey = (code: string) => code.trim().toLowerCase();

/**
 * Remembers the DSA layout choice on this device, and per anonymised case code
 * so returning to the same case restores the layout it was last viewed with.
 */
export function useDsaViewPreference(caseCode: string) {
  const key = caseKey(caseCode);
  const [view, setView] = useState<DsaView>(DEFAULT_VIEW);
  const hydrated = useRef(false);

  // Hydrate after mount (localStorage is browser-only) and whenever the case changes.
  useEffect(() => {
    const store = read();
    setView((key && store.cases[key]) || store.device);
    hydrated.current = true;
  }, [key]);

  const update = useCallback(
    (next: DsaView) => {
      setView(next);
      const store = read();
      store.device = next;
      if (key) store.cases[key] = next;
      write(store);
    },
    [key],
  );

  return [view, update] as const;
}
