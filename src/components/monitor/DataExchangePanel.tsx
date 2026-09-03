import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { exportPairedDataset, importPairedDataset } from "@/lib/eeg/exchange.functions";
import { VitalDbImportPanel } from "@/components/monitor/VitalDbImportPanel";
import { PhysionetImportPanel } from "@/components/monitor/PhysionetImportPanel";
import { SedationIcuImportPanel } from "@/components/monitor/SedationIcuImportPanel";
import { ExternalValidationPanel } from "@/components/monitor/ExternalValidationPanel";

/**
 * Pooling paired readings across devices and colleagues. Bundles carry no
 * case codes, dates, notes or free text — only the paired numbers, the coarse
 * covariates the model uses, and a per-site pseudonym so cases stay grouped.
 */
export function DataExchangePanel() {
  const [site, setSite] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const runExport = useServerFn(exportPairedDataset);
  const runImport = useServerFn(importPairedDataset);

  const exportMutation = useMutation({
    mutationFn: () => runExport({ data: { site: site.trim() } }),
    onSuccess: (bundle) => {
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cortextrace-paired-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${bundle.points.length} de-identified readings.`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Export failed."),
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const bundle = JSON.parse(await file.text()) as unknown;
      return runImport({ data: { bundle } });
    },
    onSuccess: (result) => {
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Imported ${result.inserted} readings from ${result.site}`, {
        description: result.skipped
          ? `${result.skipped} were already present and were left alone.`
          : "They will be included at the next COEBIS refit.",
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Import failed."),
  });

  return (
    <div className="space-y-4">
      <section className="panel p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Download className="size-4 text-signal" /> Export de-identified readings
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          A shareable file of your paired commercial-monitor and app readings. Case codes are
          replaced by one-way pseudonyms, exact times are reduced to the month, and no notes or
          free text are included.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="Site label, e.g. “Theatre 4”"
            className="h-11 max-w-xs sm:h-9"
            aria-label="Site label"
          />
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
          >
            {exportMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Export bundle
          </Button>
        </div>
      </section>

      <section className="panel p-3">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Upload className="size-4 text-signal" /> Import a colleague's bundle
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Imported readings join your training data and keep their own case grouping, so
          cross-validation still holds out whole patients. Re-importing the same file changes
          nothing — each reading is matched on its site reference.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importMutation.mutate(file);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          onClick={() => fileRef.current?.click()}
          disabled={importMutation.isPending}
        >
          {importMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Upload className="size-4" />
          )}
          Choose bundle file
        </Button>
      </section>

      <DatasetIntakePanel />
      <VitalDbImportPanel />
      <PhysionetImportPanel />
      <ExternalValidationPanel />
    </div>
  );
}
