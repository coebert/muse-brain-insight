import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ClipboardList, Loader2, NotebookPen } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { AppNav } from "@/components/AppNav";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  NOTE_FIELDS,
  type NoteFieldKey,
  type PatientNoteCard,
} from "@/lib/eeg/patient-notes";
import { getPatientNotes, savePatientContextNote } from "@/lib/eeg/patient-notes.functions";

export const Route = createFileRoute("/_authenticated/notes")({
  head: () => ({
    meta: [
      { title: "Clinical notes — CortexTrace" },
      {
        name: "description",
        content:
          "Write the clinical context for each patient — who they are, their baseline EEG, what could mislead the index — so COEBIS depth numbers are always read alongside the case.",
      },
      { property: "og:title", content: "Clinical notes — CortexTrace" },
      {
        property: "og:description",
        content: "Per-patient context recorded beside every depth number.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: NotesPage,
  errorComponent: ({ error }) => (
    <div role="alert" className="p-6 text-sm text-critical">
      {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6 text-sm">No patients found.</div>,
});

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 px-2 py-1">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

function PatientCard({ patient }: { patient: PatientNoteCard }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    context: patient.note.context,
    baseline: patient.note.baseline,
    confounders: patient.note.confounders,
    readWith: patient.note.readWith,
  });
  const queryClient = useQueryClient();
  const save = useServerFn(savePatientContextNote);
  const mutation = useMutation({
    mutationFn: () =>
      save({
        data: {
          patientKey: patient.patientKey,
          patientLabel: patient.label,
          ...draft,
        },
      }),
    onSuccess: async () => {
      toast.success(`Context saved for ${patient.label}`);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["patient-notes"] });
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Could not save the note."),
  });

  const n = patient.numbers;
  const stateTone =
    patient.completeness.state === "none"
      ? "text-critical"
      : patient.completeness.state === "partial"
        ? "text-warning"
        : "text-muted-foreground";

  return (
    <article className="panel p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-medium">{patient.label}</h3>
        <span className="text-xs text-muted-foreground">
          {patient.linked ? "linked patient" : "single case"} · {n.cases} case
          {n.cases === 1 ? "" : "s"} · {n.totalMinutes} min recorded
          {patient.ageBand ? ` · ${patient.ageBand}` : ""}
          {patient.sex ? ` · ${patient.sex}` : ""}
          {patient.regimen ? ` · ${patient.regimen}` : ""}
        </span>
        <span className={`text-xs ${stateTone}`}>
          {patient.completeness.filled}/{patient.completeness.total} written
        </span>
        <Button
          size="sm"
          variant={patient.completeness.state === "none" ? "default" : "outline"}
          className="ml-auto min-h-11 sm:min-h-9"
          onClick={() => setOpen(!open)}
        >
          {patient.completeness.state === "none" ? "Write context" : open ? "Close" : "Edit context"}
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Median index" value={n.medianIndex == null ? "—" : String(n.medianIndex)} />
        <Metric label="Lowest index" value={n.lowestIndex == null ? "—" : String(n.lowestIndex)} />
        <Metric
          label="Mean SR"
          value={n.meanSuppressionPct == null ? "—" : `${n.meanSuppressionPct}%`}
        />
        <Metric
          label="Peak SR"
          value={n.maxSuppressionPct == null ? "—" : `${n.maxSuppressionPct}%`}
        />
        <Metric label="Suppressed" value={`${n.suppressionMinutes} min`} />
        <Metric label="Seizure alerts" value={String(n.seizureAlerts)} />
      </div>

      <p
        className={`mt-3 rounded-md border-l-2 px-3 py-2 text-sm ${
          patient.completeness.state === "none"
            ? "border-critical bg-critical/5 text-critical"
            : "border-border bg-muted/30 text-muted-foreground"
        }`}
      >
        {patient.caveat}
      </p>

      {!open && patient.completeness.state !== "none" ? (
        <dl className="mt-3 space-y-2 text-sm">
          {NOTE_FIELDS.map((field) => {
            const value = patient.note[field.key].trim();
            if (!value) return null;
            return (
              <div key={field.key}>
                <dt className="text-xs tracking-wide text-muted-foreground uppercase">
                  {field.label}
                </dt>
                <dd className="whitespace-pre-wrap">{value}</dd>
              </div>
            );
          })}
          {patient.note.updatedAt ? (
            <p className="text-xs text-muted-foreground">
              Last written {new Date(patient.note.updatedAt).toLocaleString("en-GB")}
            </p>
          ) : null}
        </dl>
      ) : null}

      {open ? (
        <form
          className="mt-3 space-y-3 border-t border-border/60 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          {NOTE_FIELDS.map((field) => (
            <div key={field.key}>
              <label
                htmlFor={`${patient.patientKey}-${field.key}`}
                className="text-sm font-medium"
              >
                {field.label}
              </label>
              <p className="mb-1 text-xs text-muted-foreground">{field.hint}</p>
              <Textarea
                id={`${patient.patientKey}-${field.key}`}
                rows={3}
                value={draft[field.key as NoteFieldKey]}
                onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" className="min-h-11 sm:min-h-9" disabled={mutation.isPending}>
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null} Save context
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-9"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <span className="text-xs text-muted-foreground">
              Written text is encrypted at rest. Never record anything that identifies the patient.
            </span>
          </div>
        </form>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Cases behind these numbers
        </summary>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {patient.cases.map((c) => (
            <li key={c.sessionId}>
              <span className="font-medium text-foreground">{c.caseCode}</span> ·{" "}
              {new Date(c.startedAt).toLocaleDateString("en-GB")} · {c.durationMinutes} min ·
              median index {c.medianIndex ?? "—"} · mean SR{" "}
              {c.meanSuppressionPct == null ? "—" : `${c.meanSuppressionPct}%`}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function NotesPage() {
  const fetchNotes = useServerFn(getPatientNotes);
  const { data, isLoading, error } = useQuery({
    queryKey: ["patient-notes"],
    queryFn: () => fetchNotes(),
  });

  return (
    <main className="min-h-dvh bg-background px-4 py-4 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
          <Link to="/cases">
            <ArrowLeft className="size-4" /> Cases
          </Link>
        </Button>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <NotebookPen className="size-5 text-signal" /> Clinical notes
        </h1>
        <div className="ml-auto">
          <AppNav compact showBrand={false} />
        </div>
      </header>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        A depth number means nothing on its own: the same index reads differently in a frail
        elderly patient on dexmedetomidine and a young one on propofol alone. Write the context for
        each patient here — who they are, what their settled pattern looks like, what could mislead
        the index — and it is shown beside their recorded numbers everywhere they are read.
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading patients…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-critical">
          {error instanceof Error ? error.message : "Could not load the notes."}
        </p>
      ) : !data ? null : data.patients.length === 0 ? (
        <p className="panel p-3 text-sm">
          No recordings yet. Once you have saved a case it will appear here for you to write the
          context against.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="panel flex flex-wrap items-center gap-2 p-3 text-sm">
            <ClipboardList className="size-4 text-signal" />
            {data.patients.length} patient{data.patients.length === 1 ? "" : "s"} across{" "}
            {data.casesCovered} case{data.casesCovered === 1 ? "" : "s"} ·{" "}
            <span className={data.withoutContext > 0 ? "text-critical" : ""}>
              {data.withoutContext} with no context recorded
            </span>{" "}
            · {data.withFullContext} fully written up. Patients with the least context are listed
            first.
          </p>

          {data.patients.map((p) => (
            <PatientCard key={p.patientKey} patient={p} />
          ))}
        </div>
      )}
    </main>
  );
}
