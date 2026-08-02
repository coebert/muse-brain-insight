import { useEffect, useState } from "react";
import { ScanFace, Trash2, ExternalLink, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { startRegistration } from "@simplewebauthn/browser";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import {
  getPasskeyEnvironment,
  describePasskeyFailure,
  type PasskeyEnvironment,
} from "@/lib/webauthn-support";
import {
  startPasskeyRegistration,
  finishPasskeyRegistration,
} from "@/lib/webauthn.functions";

type Passkey = {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
};

export function PasskeyManager() {
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [busy, setBusy] = useState(false);
  const [env, setEnv] = useState<PasskeyEnvironment | null>(null);

  async function load() {
    const { data } = await supabase
      .from("webauthn_credentials")
      .select("id, label, created_at, last_used_at")
      .order("created_at", { ascending: false });
    setKeys((data ?? []) as Passkey[]);
  }

  useEffect(() => {
    void load();
    setEnv(getPasskeyEnvironment());
  }, []);

  async function addPasskey() {
    const current = getPasskeyEnvironment();
    setEnv(current);
    if (!current.supported) {
      toast.error("This browser doesn't support passkeys.");
      return;
    }
    if (!current.allowedToCreate) {
      toast.error(
        "Passkey setup is blocked inside the preview frame. Open the app in its own browser tab and try again.",
      );
      return;
    }
    setBusy(true);
    try {
      const options = await startPasskeyRegistration({});
      const response = await startRegistration({ optionsJSON: options as never });
      await finishPasskeyRegistration({
        data: {
          response: response as unknown as Record<string, unknown>,
          label: navigator.platform || "This device",
        },
      });
      toast.success("Passkey added — you can now sign in with Face ID / Touch ID.");
      await load();
    } catch (err) {
      toast.error(describePasskeyFailure(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const { error } = await supabase.from("webauthn_credentials").delete().eq("id", id);
    if (error) toast.error(error.message);
    else await load();
  }

  return (
    <section className="panel mt-6 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Biometric sign-in</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Register this device so you can unlock CortexTrace with Face ID, Touch ID or
            Windows Hello instead of your password.
          </p>
        </div>
        <Button size="sm" disabled={busy} onClick={() => void addPasskey()}>
          <ScanFace className="size-4" /> Add passkey
        </Button>
      </div>

      {env && env.supported && !env.allowedToCreate && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-caution/40 bg-caution/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution" />
          <div>
            <p>
              Passkey registration is blocked while the app runs inside the preview frame.
              Open CortexTrace in its own browser tab to add a passkey.
            </p>
            <a
              className="mt-1 inline-flex items-center gap-1 font-medium underline"
              href={env.standaloneUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open in a new tab <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      )}

      {env && !env.supported && (
        <p className="mt-3 text-xs text-muted-foreground">
          This browser doesn't support passkeys — use your email and password to sign in.
        </p>
      )}

      {keys.length > 0 && (
        <ul className="mt-4 space-y-2">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs"
            >
              <span>
                <span className="font-medium">{k.label ?? "Passkey"}</span>
                <span className="ml-2 text-muted-foreground">
                  added {new Date(k.created_at).toLocaleDateString()}
                  {k.last_used_at
                    ? ` · last used ${new Date(k.last_used_at).toLocaleDateString()}`
                    : ""}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => void remove(k.id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}