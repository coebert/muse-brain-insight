import { Link } from "@tanstack/react-router";
import { Bluetooth, FlaskConical, Save, Trash2 } from "lucide-react";

import { BleHeadsetPanel } from "@/components/monitor/BleHeadsetPanel";
import { CaseFields } from "@/components/monitor/CaseFields";
import { IngestPanel } from "@/components/monitor/IngestPanel";
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
import type { EegSource } from "@/lib/eeg/muse";

interface Props {
  meta: CaseMeta;
  onMetaChange: (meta: CaseMeta) => void;
  /** Case codes already filed on this device; duplicates are blocked. */
  usedCaseCodes: string[];
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
    kind: "muse" | "simulated" | "ingest",
    options?: {
      device?: BluetoothDevice;
      preset?: string;
      source?: EegSource;
      onConnectionError?: (error: unknown) => void;
    },
  ) => Promise<boolean>;
  endOpen: boolean;
  onEndOpenChange: (open: boolean) => void;
  onEnd: (fileNow: boolean) => void;
  discardOpen: boolean;
  onDiscardOpenChange: (open: boolean) => void;
  /** Destroys everything recorded for this case. */
  onDiscard: () => void;
}

/** Start-case, file-case and end-case dialogs for the live monitor. */
export function CaseDialogs({
  meta,
  onMetaChange,
  usedCaseCodes,
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
  discardOpen,
  onDiscardOpenChange,
  onDiscard,
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
              <CaseFields
                meta={meta}
                onChange={onMetaChange}
                usedCaseCodes={usedCaseCodes}
                idPrefix="save"
              />
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
          <CaseFields
            meta={meta}
            onChange={onMetaChange}
            usedCaseCodes={usedCaseCodes}
            idPrefix="start"
          />
          <PreCaseChecklist checked={checklist} onToggle={onToggleChecklist} />
          {bleSupported ? null : (
            <p className="rounded-md border border-caution/40 bg-caution/10 p-3 text-xs text-muted-foreground">
              This browser cannot reach Bluetooth devices. On iPhone or iPad open CortexTrace in
              Bluefy; on desktop or Android use Chrome or Edge. The demo signal still works here.
            </p>
          )}
          {bleSupported ? (
            <MuseCapabilityPanel
              onConfirm={(device, preset) => void onStart("muse", { device, preset })}
            />
          ) : null}
          {/* Non-Muse Bluetooth bands: FocusCalm and similar single-channel headsets. */}
          {bleSupported ? (
            <BleHeadsetPanel
              onStart={(source, onConnectionError) =>
                onStart("ingest", { source, onConnectionError })
              }
            />
          ) : null}
          {/* Any other amplifier: CSV replay, serial firmware, or an LSL bridge. */}
          <IngestPanel onStart={(source) => void onStart("ingest", { source })} />
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => void onStart("simulated")}>
              <FlaskConical className="size-4" /> Demo signal
            </Button>
            <Button variant="outline" disabled={!bleSupported} onClick={() => void onStart("muse")}>
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
              Streaming stops and the recording is closed, but everything gathered stays in the app
              — including if you move to another page. It is only deleted when you choose “Exit
              without saving”.
            </DialogDescription>
          </DialogHeader>
          <p className="metric-value text-xs text-muted-foreground">
            {formatClock(elapsed)} · {epochCount} epochs · {eventCount} events · mean SR{" "}
            {meanSr.toFixed(0)} %
          </p>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => onEnd(false)}>
              End and keep on screen
            </Button>
            <Button onClick={() => onEnd(true)}>
              <Save className="size-4" /> End and file case
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={discardOpen} onOpenChange={onDiscardOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Exit without saving?</DialogTitle>
            <DialogDescription>
              This permanently deletes everything gathered for this case — the spectral trend,
              events, markers, TCI entries and BIS readings. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <p className="metric-value text-xs text-muted-foreground">
            {formatClock(elapsed)} · {epochCount} epochs · {eventCount} events · {markerCount}{" "}
            markers
          </p>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => onDiscardOpenChange(false)}>
              Keep the data
            </Button>
            <Button variant="destructive" onClick={onDiscard}>
              <Trash2 className="size-4" /> Exit without saving
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
