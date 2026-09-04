import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteClinician, listPeople, revokePerson, setPersonRole } from "@/lib/roles.functions";

export const Route = createFileRoute("/_authenticated/_admin/admin/people")({
  head: () => ({
    meta: [
      { title: "People — CortexTrace admin" },
      {
        name: "description",
        content:
          "Invite clinicians, grant or remove administrator access and revoke accounts for CortexTrace.",
      },
      { property: "og:title", content: "People — CortexTrace admin" },
      {
        property: "og:description",
        content: "Manage who can sign in to CortexTrace and who may reach the admin area.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PeoplePage,
});

function PeoplePage() {
  const queryClient = useQueryClient();
  const fetchPeople = useServerFn(listPeople);
  const invite = useServerFn(inviteClinician);
  const setRole = useServerFn(setPersonRole);
  const revoke = useServerFn(revokePerson);
  const [email, setEmail] = useState("");

  const people = useQuery({ queryKey: ["people"], queryFn: () => fetchPeople() });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["people"] });

  const inviteMutation = useMutation({
    mutationFn: (address: string) =>
      invite({ data: { email: address, redirectTo: `${window.location.origin}/auth` } }),
    onSuccess: (r) => {
      toast.success(`Invitation sent to ${r.email}.`);
      setEmail("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const roleMutation = useMutation({
    mutationFn: (v: { userId: string; role: "admin" | "clinician" }) => setRole({ data: v }),
    onSuccess: () => {
      toast.success("Access updated.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (userId: string) => revoke({ data: { userId } }),
    onSuccess: () => {
      toast.success("Account removed.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-xl font-semibold">People</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Accounts exist by invitation only. A clinician sees the monitor, cases, patients and notes;
        only administrators reach this area.
      </p>

      <section className="panel mt-6 p-4">
        <h2 className="text-sm font-semibold">Invite a clinician</h2>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              className="mt-1.5"
              placeholder="name@hospital.nhs.uk"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button
            disabled={!email.trim() || inviteMutation.isPending}
            onClick={() => inviteMutation.mutate(email)}
          >
            {inviteMutation.isPending ? "Sending…" : "Send invitation"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          They receive a link by email and choose their own password. No admin access is granted.
        </p>
      </section>

      <section className="panel mt-4 overflow-x-auto p-4">
        <h2 className="text-sm font-semibold">Accounts</h2>
        {people.isPending ? (
          <div className="mt-3 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : people.error ? (
          <p className="mt-3 text-sm text-critical">Could not load accounts.</p>
        ) : (people.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No accounts yet.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs tracking-wide text-muted-foreground uppercase">
                <th className="py-2 pr-3 font-medium">Email</th>
                <th className="py-2 pr-3 font-medium">Access</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(people.data ?? []).map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-2 pr-3">{p.email}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        p.role === "admin"
                          ? "rounded-full bg-signal/15 px-2 py-0.5 text-xs text-signal"
                          : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      }
                    >
                      {p.role === "admin" ? "Administrator" : "Clinician"}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {p.invitedPending ? "Invitation pending" : "Active"}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={roleMutation.isPending}
                        onClick={() =>
                          roleMutation.mutate({
                            userId: p.id,
                            role: p.role === "admin" ? "clinician" : "admin",
                          })
                        }
                      >
                        {p.role === "admin" ? "Remove admin" : "Make admin"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revokeMutation.isPending}
                        onClick={() => {
                          if (confirm(`Remove ${p.email}? They will lose access immediately.`)) {
                            revokeMutation.mutate(p.id);
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
