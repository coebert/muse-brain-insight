import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";

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

  useEffect(() => {
    if (user) void navigate({ to: "/sessions" });
  }, [user, navigate]);

  async function signIn() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) toast.error(error.message);
  }

  async function signUp() {
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    if (!data.session) toast.success("Check your inbox to confirm your email address.");
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
          Sign in to save and review anonymised monitoring sessions.
        </p>

        <Tabs defaultValue="in" className="mt-6">
          <TabsList className="w-full">
            <TabsTrigger value="in" className="flex-1">
              Sign in
            </TabsTrigger>
            <TabsTrigger value="up" className="flex-1">
              Create account
            </TabsTrigger>
          </TabsList>
          <div className="mt-4 space-y-3">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
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
                className="mt-1.5"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <TabsContent value="in">
              <Button className="w-full" disabled={busy} onClick={() => void signIn()}>
                Sign in
              </Button>
            </TabsContent>
            <TabsContent value="up">
              <Button className="w-full" disabled={busy} onClick={() => void signUp()}>
                Create account
              </Button>
            </TabsContent>
            <Button variant="outline" className="w-full" onClick={() => void google()}>
              Continue with Google
            </Button>
          </div>
        </Tabs>
      </div>
    </div>
  );
}