import { useState } from "react";
import {
  Activity,
  BellRing,
  MoreHorizontal,
  ClipboardList,
  Gauge,
  MapPin,
  NotebookPen,
  Syringe,
} from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AlarmBanner } from "@/components/monitor/AlarmBanner";
import { CaseFields } from "@/components/monitor/CaseFields";
import { EventLog } from "@/components/monitor/EventLog";
import { LimitsSheet } from "@/components/monitor/LimitsSheet";
import { MarkSheet } from "@/components/monitor/MarkSheet";
import { TciPanel } from "@/components/monitor/TciPanel";
import { BisPanel } from "@/components/monitor/BisPanel";
import type { CaseControls } from "@/components/monitor/case-controls";
import { tciModel } from "@/lib/eeg/tci";
import { cn } from "@/lib/utils";
import { ParameterInfo } from "@/components/monitor/ParameterInfo";

export type CaseSheet = "mark" | "tci" | "bis" | "limits" | "alarms" | "log" | "notes" | null;

/**
 * Slim always-present bar giving one-thumb access to everything that gets
 * touched during a live case, without ever leaving the DSA.
 */
export function CaseActionBar({
  controls,
  open,
  onOpenChange,
  className,
}: {
  controls: CaseControls;
  open?: CaseSheet;
  onOpenChange?: (next: CaseSheet) => void;
  className?: string;
}) {
  const [internal, setInternal] = useState<CaseSheet>(null);
  const sheet = open !== undefined ? open : internal;
  const setSheet = onOpenChange ?? setInternal;

  const livePumps = controls.infusions.filter((i) => i.stoppedAt === null);
  const alarmCount = controls.alarms.unacknowledged.length;

  const items: {
    key: Exclude<CaseSheet, null>;
    label: string;
    icon: typeof MapPin;
    badge?: string;
  }[] = [
    { key: "mark", label: "Mark", icon: MapPin },
    {
      key: "tci",
      label: "TCI",
      icon: Syringe,
      ...(livePumps.length ? { badge: String(livePumps.length) } : {}),
    },
    {
      key: "bis",
      label: "BIS",
      icon: Activity,
      ...(controls.bisReadings.length ? { badge: String(controls.bisReadings.length) } : {}),
    },
    {
      key: "limits",
      label: "Limits",
      icon: Gauge,
      ...(controls.limitsOffDefault ? { badge: "!" } : {}),
    },
    {
      key: "alarms",
      label: "Alarms",
      icon: BellRing,
      ...(alarmCount ? { badge: String(alarmCount) } : {}),
    },
    { key: "log", label: "Log", icon: ClipboardList },
  ];
  if (controls.caseNotes) items.push({ key: "notes", label: "Notes", icon: NotebookPen });

  // Mobile keeps only the actions reached mid-case in one thumb; the rest move
  // behind "More" so no cell is narrower than a fingertip.
  const PRIMARY = new Set(["mark", "alarms", "log"]);
  const secondary = items.filter((i) => !PRIMARY.has(i.key));
  const secondaryBadges = secondary.filter((i) => i.badge).length;
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <>
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur",
          className,
        )}
      >
        <div
          className={cn(
            "mx-auto grid max-w-[1500px] grid-cols-4",
            controls.caseNotes ? "sm:grid-cols-7" : "sm:grid-cols-6",
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            const primary = PRIMARY.has(item.key);
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setSheet(item.key)}
                className={cn(
                  "relative min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                  primary ? "flex" : "hidden sm:flex",
                )}
              >
                <span className="relative">
                  <Icon className="size-5" />
                  {item.badge ? (
                    <span
                      className={cn(
                        "absolute -top-1.5 -right-2.5 min-w-4 rounded-full px-1 text-[11px] leading-4 font-semibold",
                        item.key === "alarms"
                          ? "bg-critical text-background"
                          : "bg-signal text-background",
                      )}
                    >
                      {item.badge}
                    </span>
                  ) : null}
                </span>
                {item.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:hidden"
          >
            <span className="relative">
              <MoreHorizontal className="size-5" />
              {secondaryBadges ? (
                <span className="absolute -top-1.5 -right-2.5 size-2 rounded-full bg-signal" />
              ) : null}
            </span>
            More
          </button>
        </div>
      </div>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          <SheetHeader className="px-0">
            <SheetTitle>More case actions</SheetTitle>
            <SheetDescription>Everything else available during this case.</SheetDescription>
          </SheetHeader>
          <div className="grid gap-2 pb-4">
            {secondary.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setMoreOpen(false);
                    setSheet(item.key);
                  }}
                  className="flex min-h-14 items-center gap-3 rounded-lg border border-border px-4 text-sm font-medium transition-colors hover:border-signal/60 hover:bg-signal/5"
                >
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 text-left">{item.label}</span>
                  {item.badge ? (
                    <span className="metric-value rounded-full bg-muted px-2 py-0.5 text-xs">
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={sheet !== null} onOpenChange={(v) => (v ? null : setSheet(null))}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
          {sheet === "mark" ? (
            <>
              <SheetHeader className="px-0">
                <SheetTitle>Mark event</SheetTitle>
                <SheetDescription>
                  Markers are timestamped against the case clock and drawn on the DSA.
                </SheetDescription>
              </SheetHeader>
              <MarkSheet
                elapsed={controls.elapsed}
                mode={controls.mode}
                onMark={controls.onMark}
                onDone={() => setSheet(null)}
              />
            </>
          ) : null}

          {sheet === "tci" ? (
            <>
              <SheetHeader className="px-0">
                <SheetTitle className="flex items-center gap-2">
                  TCI pumps
                  <ParameterInfo parameter="ce" size="md" />
                </SheetTitle>
                <SheetDescription>
                  {livePumps.length
                    ? livePumps.map((i) => tciModel(i.modelKey)?.short ?? i.modelKey).join(" · ")
                    : "No pump running."}
                </SheetDescription>
              </SheetHeader>
              <TciPanel
                infusions={controls.infusions}
                onChange={controls.onInfusionsChange}
                running={controls.running}
                elapsed={controls.elapsed}
                onMark={(detail) => controls.onMark(detail)}
              />
            </>
          ) : null}

          {sheet === "bis" ? (
            <>
              <SheetHeader className="px-0">
                <SheetTitle>Commercial BIS reference</SheetTitle>
                <SheetDescription>
                  Enter what the BIS monitor is displaying. Readings are timestamped against the
                  case clock and compared with the app's own depth index.
                </SheetDescription>
              </SheetHeader>
              <BisPanel
                readings={controls.bisReadings}
                onChange={controls.onBisReadingsChange}
                running={controls.running}
                elapsed={controls.elapsed}
                depthIndex={controls.live.depthIndex}
                suppressionRatio={controls.live.suppressionRatio}
                sef95={controls.live.sef95}
                coebisSeries={controls.coebisSeries ?? []}
                onMark={(detail) => controls.onMark(detail)}
              />
            </>
          ) : null}

          {sheet === "limits" ? (
            <>
              <SheetHeader className="px-0">
                <SheetTitle>Alarm limits</SheetTitle>
                <SheetDescription>
                  Every threshold that can raise an alarm, with the current live reading beside it.
                </SheetDescription>
              </SheetHeader>
              <LimitsSheet controls={controls} />
            </>
          ) : null}

          {sheet === "alarms" ? (
            <>
              <SheetHeader className="px-0">
                <SheetTitle>Alarms</SheetTitle>
                <SheetDescription>
                  {alarmCount ? `${alarmCount} unacknowledged` : "No active alarms."}
                </SheetDescription>
              </SheetHeader>
              <AlarmBanner
                alarms={controls.alarms.alarms}
                audioEnabled={controls.alarms.audioEnabled}
                muted={controls.alarms.muted}
                muteRemaining={controls.alarms.muteRemaining}
                onAcknowledge={controls.alarms.acknowledge}
                onAcknowledgeAll={controls.alarms.acknowledgeAll}
                onAcknowledgeSide={controls.alarms.acknowledgeSide}
                onPauseAudio={controls.alarms.pauseAudio}
                onResumeAudio={controls.alarms.resumeAudio}
                onToggleAudio={() => controls.alarms.setAudioEnabled(!controls.alarms.audioEnabled)}
              />
            </>
          ) : null}

          {sheet === "log" ? (
            <>
              <SheetHeader className="px-0">
                <SheetTitle>Session log</SheetTitle>
                <SheetDescription>
                  Handover summary, then detections and clinician markers, newest last.
                </SheetDescription>
              </SheetHeader>
              <dl className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {controls.handover.map((row) => (
                  <div key={row.label} className="rounded-md border border-border px-2.5 py-2">
                    <dt className="text-xs text-muted-foreground">{row.label}</dt>
                    <dd className="metric-value text-sm text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="rounded-lg border border-border">
                <EventLog events={controls.events} />
              </div>
            </>
          ) : null}

          {sheet === "notes" && controls.caseNotes ? (
            <>
              <SheetHeader className="px-0">
                <SheetTitle>Case details &amp; notes</SheetTitle>
                <SheetDescription>
                  Add or amend free text at any point during the case — it is kept with the
                  recording and saved when you file it. Never include identifiable details.
                </SheetDescription>
              </SheetHeader>
              <CaseFields
                meta={controls.caseNotes.meta}
                onChange={controls.caseNotes.onChange}
                usedCaseCodes={controls.caseNotes.usedCaseCodes ?? []}
                idPrefix="live"
              />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
