import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, FlaskConical, Search, X } from "lucide-react";
import { useState } from "react";

import { CaseResearchLink } from "@/components/monitor/CaseResearchLink";
import { ADMIN_SECTIONS } from "@/components/admin/AdminShell";

export const Route = createFileRoute("/_authenticated/_admin/admin/")({
  head: () => ({
    meta: [
      { title: "Admin — CortexTrace" },
      {
        name: "description",
        content:
          "Administration for CortexTrace: depth models, validation dashboards, data intake, alert tuning and clinician accounts.",
      },
      { property: "og:title", content: "Admin — CortexTrace" },
      {
        property: "og:description",
        content: "Model, validation, data and account administration for CortexTrace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AdminHome,
});

const LAB = {
  title: "Research lab",
  items: [
    { to: "/research-lab", label: "Try sample EEG" },
  ],
} as const;

const DETAILS: Record<string, string> = {
  "/research-lab": "Explore depth of anaesthesia, seizure patterns, brain age and stroke research with generated samples.",
  "/depth": "Compare the depth index with recorded BIS values.",
  "/pathology": "Compare EEG scores with independently recorded seizure and CNS disease labels.",
  "/brainwaves": "Inspect live raw EEG, signal quality and frequency-band power from a connected device.",
  "/ketamine": "Review fast-frequency patterns alongside declared ketamine exposure in recorded cases.",
  "/risk": "Review research estimates against observed case outcomes.",
  "/discovery": "Explore relationships between patient characteristics, devices and EEG features.",
  "/capture": "Set up an EEG recording for research.",
  "/exposure": "Review drug exposure alongside EEG changes.",
  "/suppression": "Compare EEG burst suppression with the recorded monitor reference.",
  "/replay": "Replay a recorded case through the depth model.",
  "/pairing": "Match recorded EEG and reference monitor readings.",
  "/admin/people": "Manage clinician accounts and invitations.",
};

function AdminHome() {
  const [search, setSearch] = useState("");
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sections = [LAB, ...ADMIN_SECTIONS].map((section) => ({
    title: section.title,
    items: section.items.filter((item) => {
      if (item.to === "/admin") return false;
      const text = [section.title, item.label, DETAILS[item.to] ?? ""].join(" ").toLowerCase();
      return terms.every((term) => text.includes(term));
    }),
  })).filter((section) => section.items.length > 0);
  const count = sections.reduce((total, section) => total + section.items.length, 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:py-9">
      <h1 className="text-2xl font-semibold tracking-tight">Research and administration</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Try a sample, inspect the evidence behind a model, or manage recordings and access.
      </p>

      <form role="search" className="mt-6 max-w-xl" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="tool-search" className="text-sm font-medium">Find a tool</label>
        <div className="mt-1 flex items-center gap-2 rounded-md border border-input px-3 focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input id="tool-search" type="text" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by feature or task" className="min-h-11 w-full min-w-0 bg-transparent text-base outline-none" />
          {search && (
            <button type="button" aria-label="Clear tool search" className="grid size-10 shrink-0 place-items-center rounded-md hover:bg-accent"
              onClick={() => { setSearch(""); document.getElementById("tool-search")?.focus(); }}>
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
      <p role="status" className="mt-2 text-sm text-muted-foreground">
        {terms.length > 0 ? (count ? `${count} matching ${count === 1 ? "tool" : "tools"}` : "No matching tools. Try a model name or a task such as replay.") : ""}
      </p>
      <div className="mt-4 grid items-start gap-4 sm:grid-cols-2">
        {sections.map((section) => (
          <section key={section.title} className="panel min-w-0 p-4">
            <h2 className="mb-2 flex items-center gap-2 text-base font-semibold">
              {section.title === LAB.title && <FlaskConical className="size-4 text-signal" aria-hidden="true" />}
              {section.title}
            </h2>
            <ul className="divide-y divide-border">
              {section.items.map((item) => {
                const content = (
                  <>
                    <span>
                      <span className="font-medium">{item.label}</span>
                      {DETAILS[item.to] && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{DETAILS[item.to]}</span>}
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                  </>
                );
                const className = "group flex min-h-11 items-center justify-between gap-3 rounded-sm px-1 py-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";
                return (
                  <li key={item.to}>
                    {item.to === "/research-lab" ? (
                      <CaseResearchLink className={className}>{content}</CaseResearchLink>
                    ) : (
                      <Link to={item.to} className={className}>{content}</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
