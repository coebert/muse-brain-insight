import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Activity, ScanFace } from "lucide-react";
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
  // Session state lives in browser storage, so render this screen client-side only.
  ssr: false,
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

  useEffect(() => {
    if (user) void navigate({ to: "/sessions" });
  }, [user, navigate]);

  async function signIn() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) toast.error(error.message);
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
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="panel w-full max-w-sm px-6 py-7">
        <Link to="/" className="flex items-center gap-2">
          <Activity className="size-5 text-signal" />
          <span className="text-sm font-semibold tracking-[0.18em] uppercase">CortexTrace</span>
        </Link>
        <p className="mt-2 text-sm text-muted-foreground">
          This monitor is private. Sign in to view live traces and saved sessions.
        </p>

        <div className="mt-6">
          <div className="space-y-3">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
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
                autoComplete="current-password"
                className="mt-1.5"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button className="w-full" disabled={busy} onClick={() => void signIn()}>
              Sign in
            </Button>
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() => void biometricSignIn()}
            >
              <ScanFace className="size-4" /> Face ID / Touch ID
            </Button>
            <Button variant="outline" className="w-full" onClick={() => void google()}>
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
              Biometric sign-in works once you have added a passkey from the Sessions page on
              this device.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}