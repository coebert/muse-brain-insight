import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { unseal } from "@/lib/privacy";
import { fetchEpochs, fetchEvents } from "@/lib/eeg/db-rows";
import { downloadSessionReportPdf, type ReportSessionMeta } from "@/lib/eeg/pdf-report";

interface Props {
  sessionId: string;
  /** Already-decrypted session row, when the caller has one. */
  session?: ReportSessionMeta | undefined;
  modelNote?: string | undefined;
  label?: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "sm" | "default";
  className?: string;
}

/**
 * One-click PDF export: pulls the stored epochs and events for a case and
 * renders the DSA, burst-suppression timeline and seizure findings to a file.
 */
export function SessionPdfButton({
  sessionId,
  session,
  modelNote,
  label = "Download PDF report",
  variant = "default",
  size = "sm",
  className,
}: Props) {
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    const toastId = toast.loading("Building session report…");
    try {
      let meta = session;
      if (!meta) {
        const { data, error } = await supabase
          .from("eeg_sessions")
          .select("*")
          .eq("id", sessionId)
          .single();
        if (error) throw error;
        const rows = await unseal([data], ["case_code", "location", "notes", "admission_diagnosis"]);
        meta = rows[0] as ReportSessionMeta;
      }
      const [epochs, events] = await Promise.all([fetchEpochs(sessionId), fetchEvents(sessionId)]);
      downloadSessionReportPdf({
        session: meta,
        epochs,
        events,
        ...(modelNote ? { modelNote } : {}),
      });
      toast.success("Session report downloaded", { id: toastId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not build the report", {
        id: toastId,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      disabled={busy}
      onClick={() => void generate()}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
      {label}
    </Button>
  );
}
