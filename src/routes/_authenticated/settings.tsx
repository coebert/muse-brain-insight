import { createFileRoute } from "@tanstack/react-router";

import { AppNav } from "@/components/AppNav";
import { PasskeyManager } from "@/components/PasskeyManager";
import { DataPrivacyPanel } from "@/components/DataPrivacyPanel";
import { BatteryAlertPanel } from "@/components/BatteryAlertPanel";
import { TimeZonePanel } from "@/components/TimeZoneControl";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({
    meta: [
      { title: "Settings — CortexTrace" },
      {
        name: "description",
        content:
          "Manage passkey sign-in and patient data privacy: export or permanently delete anonymised EEG records.",
      },
      { property: "og:title", content: "Settings — CortexTrace" },
      {
        property: "og:description",
        content: "Passkey sign-in and data privacy controls for CortexTrace.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
          <AppNav />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 py-6 sm:px-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign-in security and stored patient data. Records are anonymised and free-text fields are
          encrypted at rest.
        </p>
        <PasskeyManager />
        <TimeZonePanel />
        <BatteryAlertPanel />
        <DataPrivacyPanel onChanged={() => undefined} />
      </main>
    </div>
  );
}
