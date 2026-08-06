import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";
import type { CaseMeta } from "@/lib/eeg/case-meta";
import { buildFeatureDigest } from "@/lib/eeg/features";
import { interpretSession, type Interpretation } from "@/lib/eeg/interpret.functions";
import { summariseInfusions, type TciInfusion } from "@/lib/eeg/tci";
import { buildTciResponseDigest } from "@/lib/eeg/tci-response";
import { interpretTciResponse, type TciResponseReport } from "@/lib/eeg/tci-response.functions";
import { buildBisComparison, summariseBis, type BisReading } from "@/lib/eeg/bis";
import {
  interpretBisAgreement,
  type BisAgreementReport,
} from "@/lib/eeg/bis-agreement.functions";

/** How often continuous surveillance re-reviews the case while streaming. */
const WATCH_INTERVAL_MS = 180_000;
/** Minimum epochs before an automatic review is worth running. */
const MIN_EPOCHS = 30;

export interface UseCaseAiOptions {
  signedIn: boolean;
  epochs: Epoch[];
  events: DetectedEvent[];
  elapsed: number;
  meta: CaseMeta;
  infusions: TciInfusion[];
  /** Values transcribed from a commercial BIS monitor running alongside. */
  bisReadings: BisReading[];
  modeLabel: string;
  streaming: boolean;
}

/**
 * AI decision-support state for the live case: session interpretation with
 * optional continuous surveillance, plus the TCI dose–response read. Both
 * calls are single-flight so a slow gateway reply cannot overtake a newer one.
 */
export function useCaseAi(options: UseCaseAiOptions) {
  const {
    signedIn,
    epochs,
    events,
    elapsed,
    meta,
    infusions,
    bisReadings,
    modeLabel,
    streaming,
  } = options;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const sessionInFlight = useRef(false);
  const tciInFlight = useRef(false);
  const bisInFlight = useRef(false);
  const seenAlertIds = useRef<Set<string>>(new Set());

  const [result, setResult] = useState<Interpretation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watch, setWatch] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);

  const [tciReport, setTciReport] = useState<TciResponseReport | null>(null);
  const [tciLoading, setTciLoading] = useState(false);
  const [tciError, setTciError] = useState<string | null>(null);

  const [bisReport, setBisReport] = useState<BisAgreementReport | null>(null);
  const [bisLoading, setBisLoading] = useState(false);
  const [bisError, setBisError] = useState<string | null>(null);

  const runInterpretation = useServerFn(interpretSession);
  const runTciInterpretation = useServerFn(interpretTciResponse);
  const runBisInterpretation = useServerFn(interpretBisAgreement);

  const analyse = useCallback(
    async (silent = false) => {
      if (!signedIn) {
        if (!silent) toast.error("Sign in to use AI interpretation.");
        return;
      }
      // A slow gateway call must not be overtaken by the surveillance timer:
      // two in flight would race and the later reply would win arbitrarily.
      if (sessionInFlight.current) return;
      sessionInFlight.current = true;
      setLoading(true);
      setError(null);
      try {
        const digest = buildFeatureDigest(
          epochs,
          events,
          {
            ageYears: meta.ageYears,
            sex: meta.sex,
            admissionDiagnosis: meta.admissionDiagnosis,
            clinicalFeatures: meta.clinicalFeatures,
            context: meta.context,
            caseSummary: meta.caseSummary,
            // Give the interpreter the drug regimen running right now, so
            // depth and nociception findings are read in context.
            notes: [
              meta.notes,
              `TCI in progress — ${summariseInfusions(infusions)}`,
              `Commercial BIS reference — ${summariseBis(bisReadings)}`,
            ]
              .filter(Boolean)
              .join(" | "),
          },
          elapsed,
          modeLabel,
        );
        const next = await runInterpretation({ data: { digest } });
        if (!mounted.current) return;
        setResult(next);
        setLastRunAt(Date.now());
        // Raise a toast only for problems we have not already surfaced.
        for (const alert of next.alerts ?? []) {
          if (seenAlertIds.current.has(alert.id)) continue;
          seenAlertIds.current.add(alert.id);
          if (alert.severity === "critical") {
            toast.error(alert.title, {
              description: alert.action || alert.detail,
              duration: 15000,
            });
          } else if (alert.severity === "warning") {
            toast.warning(alert.title, {
              description: alert.action || alert.detail,
              duration: 10000,
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI analysis failed.";
        if (!mounted.current) return;
        setError(message);
        if (!silent) toast.error(message);
      } finally {
        sessionInFlight.current = false;
        if (mounted.current) setLoading(false);
      }
    },
    [
      signedIn,
      epochs,
      events,
      elapsed,
      meta,
      infusions,
      bisReadings,
      modeLabel,
      runInterpretation,
    ],
  );

  const analyseRef = useRef(analyse);
  analyseRef.current = analyse;

  /** Ce steps and whole-case dose–response, recomputed as the EEG accrues. */
  const tciDigest = useMemo(
    () => buildTciResponseDigest(epochs, events, infusions, elapsed),
    [epochs, events, infusions, elapsed],
  );

  const analyseTci = useCallback(async () => {
    if (!signedIn) {
      toast.error("Sign in to use AI interpretation.");
      return;
    }
    if (tciInFlight.current) return;
    tciInFlight.current = true;
    setTciLoading(true);
    setTciError(null);
    try {
      const next = await runTciInterpretation({
        data: {
          digest: tciDigest,
          patient: {
            ageYears: meta.ageYears,
            sex: meta.sex,
            admissionDiagnosis: meta.admissionDiagnosis,
            clinicalFeatures: meta.clinicalFeatures,
            context: meta.context,
            mode: modeLabel,
          },
        },
      });
      if (!mounted.current) return;
      setTciReport(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI analysis failed.";
      if (!mounted.current) return;
      setTciError(message);
      toast.error(message);
    } finally {
      tciInFlight.current = false;
      if (mounted.current) setTciLoading(false);
    }
  }, [signedIn, tciDigest, meta, modeLabel, runTciInterpretation]);

  /** Paired BIS vs app depth index, recomputed as readings and EEG accrue. */
  const bisDigest = useMemo(
    () => buildBisComparison(epochs, bisReadings, elapsed),
    [epochs, bisReadings, elapsed],
  );

  const analyseBis = useCallback(async () => {
    if (!signedIn) {
      toast.error("Sign in to use AI interpretation.");
      return;
    }
    if (bisInFlight.current) return;
    bisInFlight.current = true;
    setBisLoading(true);
    setBisError(null);
    try {
      const next = await runBisInterpretation({
        data: {
          digest: bisDigest,
          patient: {
            ageYears: meta.ageYears,
            sex: meta.sex,
            admissionDiagnosis: meta.admissionDiagnosis,
            clinicalFeatures: meta.clinicalFeatures,
            context: meta.context,
            mode: modeLabel,
          },
        },
      });
      if (!mounted.current) return;
      setBisReport(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI analysis failed.";
      if (!mounted.current) return;
      setBisError(message);
      toast.error(message);
    } finally {
      bisInFlight.current = false;
      if (mounted.current) setBisLoading(false);
    }
  }, [signedIn, bisDigest, meta, modeLabel, runBisInterpretation]);

  // Continuous surveillance: re-review the session every few minutes.
  const epochCount = epochs.length;
  useEffect(() => {
    if (!watch || !streaming) return;
    const id = setInterval(() => {
      if (epochCount >= MIN_EPOCHS) void analyseRef.current(true);
    }, WATCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [watch, streaming, epochCount]);

  const setWatchEnabled = useCallback(
    (next: boolean) => {
      setWatch(next);
      if (next) {
        toast.info("Continuous AI surveillance on — reviewing every 3 minutes.");
        if (epochCount >= MIN_EPOCHS) void analyseRef.current(true);
      }
    },
    [epochCount],
  );

  /** Clears the AI state at the start of a new case. */
  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    setTciReport(null);
    setTciError(null);
    setBisReport(null);
    setBisError(null);
    seenAlertIds.current.clear();
  }, []);

  return {
    result,
    loading,
    error,
    watch,
    setWatchEnabled,
    lastRunAt,
    analyse,
    tciDigest,
    tciReport,
    tciLoading,
    tciError,
    analyseTci,
    bisDigest,
    bisReport,
    bisLoading,
    bisError,
    analyseBis,
    reset,
  };
}
