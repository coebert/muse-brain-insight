import { useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { revealPatientIdentifier } from "@/lib/eeg/patient-link.functions";
import { deidLabel, type DeidFinding } from "@/lib/eeg/deid";

/**
 * Shows the pseudonym a recording is filed under, with a deliberate,
 * one-off reveal of the sealed hospital identifier behind it.
 */
export function PatientLinkBadge({
  linkId,
  pseudonym,
  findings = [],
}: {
  linkId: string | null;
  pseudonym: string | null;
  /** What automatic de-identification removed from this case's free text. */
  findings?: DeidFinding[];
}) {
  const [identifier, setIdentifier] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reveal() {
    if (!linkId) return;
    setBusy(true);
    try {
      const result = await revealPatientIdentifier({ data: { linkId } });
      setIdentifier(result.identifier ?? "—");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not unseal that identifier.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel no-print mt-3 flex flex-col gap-2 px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-px size-4 shrink-0 text-signal" />
        <div>
          <p className="font-medium text-foreground">
            {pseudonym ? `Patient ${pseudonym}` : "Unlinked recording"}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {pseudonym
              ? "Reviewed anonymously. The hospital identifier is encrypted in a separate linkage record."
              : "No hospital identifier was linked to this case."}
            {findings.length
              ? ` Auto-redacted from free text: ${findings
                  .map((f) => `${f.count} ${deidLabel(f.kind)}${f.count === 1 ? "" : "s"}`)
                  .join(", ")}.`
              : ""}
          </p>
          {identifier ? (
            <p className="mt-1 font-mono text-sm text-foreground">{identifier}</p>
          ) : null}
        </div>
      </div>
      {linkId ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 shrink-0 gap-1.5 sm:min-h-9"
          disabled={busy}
          onClick={() => (identifier ? setIdentifier(null) : void reveal())}
        >
          {identifier ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {identifier ? "Hide identifier" : busy ? "Unsealing…" : "Reveal identifier"}
        </Button>
      ) : null}
    </div>
  );
}
