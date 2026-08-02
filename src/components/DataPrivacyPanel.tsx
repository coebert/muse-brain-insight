import { useState } from "react";
import { Download, Lock, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { deleteAllMyData, exportMyData } from "@/lib/privacy.functions";
import { downloadJson } from "@/lib/privacy";

export function DataPrivacyPanel({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function exportAll() {
    setBusy(true);
    try {
      const bundle = await exportMyData({ data: {} });
      downloadJson(`cortextrace-export-${new Date().toISOString().slice(0, 10)}.json`, bundle);
      toast.success("Export downloaded.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAll() {
    setBusy(true);
    try {
      await deleteAllMyData({});
      toast.success("All stored patient records deleted.");
      setConfirming(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel mt-6 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Lock className="size-4 text-signal" /> Data protection
          </h2>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            Records are stored on encrypted-at-rest managed infrastructure, and every free-text
            field (case code, location, admission diagnosis, notes) is additionally sealed with
            AES-256-GCM using a server-held key, so it is unreadable in the database itself.
            Access is restricted to your signed-in account by row-level security.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportAll()}>
            <Download className="size-4" /> Export all data
          </Button>
          <Button
            size="sm"
            variant={confirming ? "destructive" : "ghost"}
            disabled={busy}
            onClick={() => (confirming ? void deleteAll() : setConfirming(true))}
          >
            <Trash2 className="size-4" />
            {confirming ? "Confirm permanent delete" : "Delete all data"}
          </Button>
        </div>
      </div>
      {confirming ? (
        <p className="mt-3 text-xs text-destructive">
          This permanently removes every saved session, epoch, event and label. Export first if you
          need a copy.{" "}
          <button className="underline" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </p>
      ) : null}
    </section>
  );
}