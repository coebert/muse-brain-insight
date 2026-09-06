import { Link } from "@tanstack/react-router";
import { Activity, Menu, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const ADMIN_SECTIONS = [
  {
    title: "Models",
    items: [
      { to: "/models", label: "Model versions" },
      { to: "/coebis", label: "COEBIS training data" },
      { to: "/training", label: "Refit history" },
      { to: "/calibrate", label: "Depth calibration" },
      { to: "/blockers", label: "Blocked lineages" },
      { to: "/suppression", label: "Suppression model" },
    ],
  },
  {
    title: "Validation",
    items: [
      { to: "/depth", label: "Depth dashboard" },
      { to: "/flags", label: "Suppression flags" },
      { to: "/validate", label: "Agreement report" },
      { to: "/bis-benchmark", label: "COEBIS vs BIS" },
      { to: "/pathology", label: "Pathology validation" },
      { to: "/compare", label: "Compare metrics" },
      { to: "/replay", label: "COEBIS replay" },
      { to: "/trends", label: "Session trends" },
      { to: "/brainwaves", label: "Live brainwaves" },
    ],
  },
  {
    title: "Data",
    items: [
      { to: "/capture", label: "Data collection" },
      { to: "/depth-intake", label: "Depth corpus intake" },
      { to: "/corpus-upload", label: "Corpus upload" },
      { to: "/reference", label: "Reference library" },
      { to: "/pairing", label: "Pair monitor readings" },
      { to: "/drugs", label: "Drug library" },
      { to: "/exposure", label: "Drug exposure" },
      { to: "/ketamine", label: "Ketamine signature" },
      { to: "/outcomes", label: "Case outcomes" },
      { to: "/discovery", label: "Device discovery" },
    ],
  },
  {
    title: "Alerts",
    items: [
      { to: "/feedback", label: "Alert feedback" },
      { to: "/performance", label: "Alert tuning" },
    ],
  },
  {
    title: "Access",
    items: [
      { to: "/admin", label: "Admin home" },
      { to: "/admin/people", label: "People" },
    ],
  },
] as const;

/** Desktop-first admin chrome: fixed sidebar, collapsible on small screens. */
export function AdminShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="space-y-5">
      {ADMIN_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="px-2 text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            {section.title}
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-2 py-1.5 text-sm text-foreground/85 transition-colors hover:bg-accent hover:text-foreground"
                  activeProps={{ className: "bg-accent font-medium text-foreground" }}
                  activeOptions={{ exact: item.to === "/admin" }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle admin menu"
          >
            {open ? <Menu className="size-4" /> : <Menu className="size-4" />}
          </Button>
          <Link to="/" className="flex min-w-0 items-center gap-2">
            <Activity className="size-5 shrink-0 text-signal" />
            <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
              CortexTrace
            </span>
          </Link>
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] tracking-wide text-muted-foreground uppercase">
            Admin
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button asChild variant="ghost" size="sm">
              <Link to="/">Back to monitor</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void supabase.auth.signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="flex">
        <aside className="sticky top-[52px] hidden h-[calc(100dvh-52px)] w-60 shrink-0 overflow-y-auto border-r border-border bg-sidebar px-2 py-4 lg:block">
          {nav}
        </aside>

        {open ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              className="absolute inset-0 bg-background/80"
              aria-label="Close admin menu"
              onClick={() => setOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 w-64 overflow-y-auto border-r border-border bg-sidebar px-2 py-4">
              <div className="mb-3 flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  <X className="size-4" />
                </Button>
              </div>
              {nav}
            </div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
