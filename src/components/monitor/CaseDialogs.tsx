import { Link } from "@tanstack/react-router";
import { Bluetooth, FlaskConical, Save } from "lucide-react";

import { CaseFields } from "@/components/monitor/CaseFields";
import { MuseCapabilityPanel } from "@/components/monitor/MuseCapabilityPanel";
import { PreCaseChecklist, type ChecklistKey } from "@/components/monitor/PreCaseChecklist";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CaseMeta } from "@/lib/eeg/case-meta";
import { formatClock } from "@/lib/eeg/format";

interface Props {
  meta: CaseMeta;
  onMetaChange: (meta: CaseMeta) => void;
  signedIn: boolean;
  epochCount: number;
  eventCount: number;
  markerCount: number;
  elapsed: number;
  meanSr: number;
  bleSupported: boolean;
  checklist: Record<string, boolean>;
  onToggleChecklist: (key: ChecklistKey) => void;
  saveOpen: boolean;
  onSaveOpenChange: (open: boolean) => void;
  saving: boolean;
  onSave: () => void;
  caseOpen: boolean;
  onCaseOpenChange: (open: boolean) => void;
  onStart: (
    kind: "muse" | "simulated",
    options?: { device?: BluetoothDevice; preset?: string },
  ) => void;
  endOpen: boolean;
  onEndOpenChange: (open: boolean) => void;
  onEnd: (fileNow: boolean) => void;
}

/** Start-case, file-case and end-case dialogs for the live monitor. */
export function CaseDialogs({
  meta,
  onMetaChange,
  signedIn,
  epochCount,
  eventCount,
  markerCount,
  elapsed,
  meanSr,
  bleSupported,
  checklist,
  onToggleChecklist,
  saveOpen,
  onSaveOpenChange,
  saving,
  onSave,
  caseOpen,
  onCaseOpenChange,
  onStart,
  endOpen,
  onEndOpenChange,
  onEnd,
}: Props) {
  return (
    <>
      <Dialog open={saveOpen} onOpenChange={onSaveOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>File this case</DialogTitle>
            <DialogDescription>
              Only the case code you type here is stored — no names, dates of birth or hospital
              numbers. Use a code that cannot identify the patient outside your own records.
            </DialogDescription>
          </DialogHeader>
          {signedIn ? (
            <>
              <CaseFields meta={meta} onChange={onMetaChange} idPrefix="save" />
              <p className="metric-value text-xs text-muted-foreground">
                {epochCount} epochs · {formatClock(elapsed)} · {eventCount} events ({markerCount}{" "}
                clinician markers)
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Sign in to store sessions securely against your own account.
            </p>
          )}
          <DialogFooter>
            {signedIn ? (
              <Button onClick={onSave} disabled={saving}>
                {saving ? "Saving…" : "Save session"}
              </Button>
            ) : (
              <Button asChild>
                <Link to="/auth">Sign in</Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={caseOpen} onOpenChange={onCaseOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Start a case</DialogTitle>
            <DialogDescription>
              Record the case details before streaming. The case then survives a headband dropout
              and can be filed at the end without retyping anything.
            </DialogDescription>
          </DialogHeader>
          <CaseFields meta={meta} onChange={onMetaChange} idPrefix="start" />
          <PreCaseChecklist checked={checklist} onToggle={onToggleChecklist} />
          {bleSupported ? null : (
            <p className="rounded-md border border-caution/40 bg-caution/10 p-3 text-xs text-muted-foreground">
              This browser cannot reach Bluetooth devices. On iPhone or iPad open CortexTrace in
              Bluefy; on desktop or Android use Chrome or Edge. The demo signal still works here.
            </p>
          )}
          {bleSupported ? (
            <MuseCapabilityPanel
              onConfirm={(device, preset) => onStart("muse", { device, preset })}
            />
          ) : null}
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => onStart("simulated")}>
              <FlaskConical className="size-4" /> Demo signal
            </Button>
            <Button variant="outline" disabled={!bleSupported} onClick={() => onStart("muse")}>
              <Bluetooth className="size-4" /> Skip detection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={endOpen} onOpenChange={onEndOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End case {meta.caseCode ? `“${meta.caseCode}”` : ""}?</DialogTitle>
            <DialogDescription>
              Streaming stops and the recording is closed. File it now to keep the trend, events and
              alarm history — nothing is stored until you do.
            </DialogDescription>
          </DialogHeader>
          <p className="metric-value text-xs text-muted-foreground">
            {formatClock(elapsed)} · {epochCount} epochs · {eventCount} events · mean SR{" "}
            {meanSr.toFixed(0)} %
          </p>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => onEnd(false)}>
              End without filing
            </Button>
            <Button onClick={() => onEnd(true)}>
              <Save className="size-4" /> End and file case
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
