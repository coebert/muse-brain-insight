import { useState } from "react";
import { BellRing, ClipboardList, Gauge, MapPin, NotebookPen, Syringe } from "lucide-react";

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
import type { CaseControls } from "@/components/monitor/case-controls";
import { tciModel } from "@/lib/eeg/tci";
import { cn } from "@/lib/utils";
import { ParameterInfo } from "@/components/monitor/ParameterInfo";

export type CaseSheet = "mark" | "tci" | "limits" | "alarms" | "log" | "notes" | null;

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
            "mx-auto grid max-w-[1500px]",
            controls.caseNotes ? "grid-cols-6" : "grid-cols-5",
          )}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setSheet(item.key)}
                className="relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icon className="size-5" />
                {item.label}
                {item.badge ? (
                  <span
                    className={cn(
                      "absolute top-1.5 right-[22%] min-w-4 rounded-full px-1 text-[10px] leading-4 font-semibold",
                      item.key === "alarms"
                        ? "bg-critical text-background"
                        : "bg-signal text-background",
                    )}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

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
                idPrefix="live"
              />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
