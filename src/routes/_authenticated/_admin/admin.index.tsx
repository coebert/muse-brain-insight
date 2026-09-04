import { createFileRoute, Link } from "@tanstack/react-router";

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

function AdminHome() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-xl font-semibold">Administration</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Everything behind the bedside display: how the depth index is fitted, how it is validated
        against recorded monitors, what data feeds it, and who may sign in.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {ADMIN_SECTIONS.filter((s) => s.title !== "Access").map((section) => (
          <section key={section.title} className="panel p-4">
            <h2 className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
              {section.title}
            </h2>
            <ul className="mt-2 space-y-1">
              {section.items.map((item) => (
                <li key={item.to}>
                  <Link to={item.to} className="text-sm text-foreground hover:text-signal">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section className="panel p-4">
          <h2 className="text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            Access
          </h2>
          <ul className="mt-2 space-y-1">
            <li>
              <Link to="/admin/people" className="text-sm text-foreground hover:text-signal">
                People and invitations
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
