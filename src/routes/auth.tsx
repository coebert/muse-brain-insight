import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Activity, ArrowRight, ScanFace } from "lucide-react";
import { toast } from "sonner";
import { startAuthentication } from "@simplewebauthn/browser";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import {
  getPasskeyEnvironment,
  describePasskeyFailure,
  summarisePasskeyFailure,
  type PasskeyFailure,
} from "@/lib/webauthn-support";
import { PasskeyErrorNotice } from "@/components/PasskeyErrorNotice";
import { startPasskeyLogin, finishPasskeyLogin } from "@/lib/webauthn.functions";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Clinician sign in — CortexTrace EEG monitor" },
      {
        name: "description",
        content:
          "Sign in to CortexTrace to store and review anonymised Muse 2 EEG monitoring sessions from theatre and ICU.",
      },
      { property: "og:title", content: "Clinician sign in — CortexTrace EEG monitor" },
      {
        property: "og:description",
        content: "Access your anonymised depth-of-anaesthesia EEG session records.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PasskeyFailure | null>(null);
  const [standaloneUrl, setStandaloneUrl] = useState<string | undefined>(undefined);
  // Keep the public sample entry available while the session controls hydrate.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (user) void navigate({ to: "/sessions" });
  }, [user, navigate]);

  async function signIn() {
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) toast.error(error.message);
    } catch {
      toast.error("Sign-in could not complete. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function biometricSignIn() {
    setFailure(null);
    if (!email.trim()) {
      toast.error("Enter your email address first.");
      return;
    }
    const env = getPasskeyEnvironment();
    setStandaloneUrl(env.standaloneUrl);
    if (!env.supported) {
      setFailure(
        describePasskeyFailure(
          new DOMException("WebAuthn API is unavailable in this browser.", "NotSupportedError"),
          env,
        ),
      );
      return;
    }
    if (env.embedded) {
      setFailure(
        describePasskeyFailure(
          new DOMException(
            "publickey-credentials-get is blocked by the embedding frame's permissions policy.",
            "NotAllowedError",
          ),
          env,
        ),
      );
      return;
    }
    setBusy(true);
    try {
      const options = await startPasskeyLogin({ data: { email } });
      const response = await startAuthentication({ optionsJSON: options as never });
      const { tokenHash } = await finishPasskeyLogin({
        data: { email, response: response as unknown as Record<string, unknown> },
      });
      const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: "magiclink",
      });
      if (error) throw new Error(error.message);
    } catch (err) {
      const detail = describePasskeyFailure(err, getPasskeyEnvironment());
      setFailure(detail);
      toast.error(summarisePasskeyFailure(detail));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) toast.error("Google sign-in failed.");
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
      <div className="panel w-full max-w-md px-5 py-6 sm:px-7">
        <Link to="/" className="flex items-center gap-2">
          <Activity className="size-5 text-signal" />
          <span className="text-sm font-semibold tracking-[0.18em] uppercase">CortexTrace</span>
        </Link>
        <section className="my-6 rounded-lg border border-border bg-muted/35 p-4" aria-labelledby="sample-heading">
          <h1 id="sample-heading" className="text-lg font-semibold">EEG research lab</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Explore seizure detection, brain age and depth of anaesthesia with sample signals.
            You can try the lab without an account or headset.
          </p>
          <Button asChild variant="outline" className="mt-3 min-h-11">
            <Link to="/research-lab">Try sample EEG <ArrowRight aria-hidden="true" className="size-4" /></Link>
          </Button>
        </section>

        <h2 className="text-lg font-semibold">Clinician sign in</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Access live monitoring and saved sessions.
        </p>
        {mounted && (
          <div className="mt-4 space-y-3">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) void signIn();
              }}
            >
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoComplete="username webauthn"
                  className="mt-1.5"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="pw">Password</Label>
                <Input
                  id="pw"
                  type="password"
                  required
                  autoComplete="current-password"
                  className="mt-1.5"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" className="min-h-11 w-full" disabled={busy}>
                Sign in
              </Button>
            </form>
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 w-full"
              disabled={busy}
              onClick={() => void biometricSignIn()}
            >
              <ScanFace className="size-4" /> Face ID / Touch ID
            </Button>
            <Button type="button" variant="outline" className="min-h-11 w-full" onClick={() => void google()}>
              Continue with Google
            </Button>
            {failure && (
              <PasskeyErrorNotice
                failure={failure}
                standaloneUrl={standaloneUrl}
                onDismiss={() => setFailure(null)}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Biometric sign-in works once you have added a passkey from the Sessions page on this
              device.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
