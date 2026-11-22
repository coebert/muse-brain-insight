import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppNav } from "@/components/AppNav";
import { AdminShell, ADMIN_SECTIONS } from "@/components/admin/AdminShell";
import { Route as AuthRoute } from "@/routes/auth";
import { Route as DirectoryRoute } from "@/routes/_authenticated/_admin/admin.index";
import { Route as PrivateRoute } from "@/routes/_authenticated/route";
import { Route as AdminRoute } from "@/routes/_authenticated/_admin";

const state = vi.hoisted(() => ({
  isAdmin: false,
  caseRunning: false,
  hasUnfiledData: false,
  getUser: vi.fn(),
  assertAdmin: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/hooks/useRole", () => ({ useIsAdmin: () => ({ isAdmin: state.isAdmin }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/roles.functions", () => ({ assertAdmin: state.assertAdmin }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getUser: state.getUser, signOut: state.signOut } },
}));
vi.mock("@/integrations/lovable/index", () => ({ lovable: {} }));
vi.mock("@/lib/webauthn.functions", () => ({
  startPasskeyLogin: vi.fn(),
  finishPasskeyLogin: vi.fn(),
}));
vi.mock("@/components/monitor/ActiveCaseBar", () => ({ ActiveCaseBar: () => null }));
vi.mock("@/components/monitor/CaseSessionProvider", () => ({
  CaseSessionProvider: ({ children }: { children: ReactNode }) => children,
  useCaseSession: () => ({ caseRunning: state.caseRunning, hasUnfiledData: state.hasUnfiledData }),
}));

function renderInRouter(children: ReactNode) {
  const routeTree = createRootRoute({ component: () => children });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

const Auth = AuthRoute.options.component!;
const Directory = DirectoryRoute.options.component!;

beforeEach(() => {
  state.isAdmin = false;
  state.caseRunning = false;
  state.hasUnfiledData = false;
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("research entry and clinical workspace navigation", { timeout: 60_000 }, () => {
  it("offers the sample before sign-in and keeps all three clinician sign-in methods", async () => {
    renderInRouter(<Auth />);
    const sample = await screen.findByRole("link", { name: "Try sample EEG" });
    expect(sample).toHaveAttribute("href", "/research-lab");
    expect(sample).not.toHaveAttribute("target");
    expect(await screen.findByRole("button", { name: "Sign in with password" })).toHaveAttribute(
      "type",
      "submit",
    );
    expect(screen.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    expect(state.getUser).not.toHaveBeenCalled();
  });

  it("keeps monitor, bedside, records and settings reachable by keyboard and hides clinician-ineligible admin links", async () => {
    const user = userEvent.setup();
    renderInRouter(<AppNav />);
    expect(await screen.findByRole("link", { name: "Monitor" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Bedside" })).toHaveAttribute("href", "/bedside");
    expect(screen.getByRole("link", { name: "Research lab" })).not.toHaveAttribute("target");
    const records = screen.getByRole("button", { name: "Records" });
    records.focus();
    await user.keyboard("{ArrowDown}");
    const menu = await screen.findByRole("menu");
    for (const [name, href] of [
      ["Cases", "/cases"],
      ["Patients", "/patients"],
      ["Notes", "/notes"],
    ] as const) {
      expect(within(menu).getByRole("menuitem", { name })).toHaveAttribute("href", href);
    }
    await user.keyboard("{Escape}");
    expect(records).toHaveFocus();
    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByRole("menuitem", { name: "Admin" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(state.signOut).toHaveBeenCalledOnce();
  });

  it("exposes admin for the application administrator role", async () => {
    state.isAdmin = true;
    const user = userEvent.setup();
    renderInRouter(<AppNav compact />);
    expect(await screen.findByRole("link", { name: "Research lab" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Monitor" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(await screen.findByRole("menuitem", { name: "Admin" })).toHaveAttribute(
      "href",
      "/admin",
    );
  });

  it.each(["running", "unfiled"])(
    "opens sample links independently for a %s case",
    async (situation) => {
      state.caseRunning = situation === "running";
      state.hasUnfiledData = situation === "unfiled";
      const { container } = renderInRouter(
        <>
          <AppNav />
          <Directory />
        </>,
      );
      await screen.findByText("Try sample EEG");
      const links = container.querySelectorAll('a[href="/research-lab"]');
      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link.textContent).toContain("opens in a new tab");
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
      }
    },
  );

  it("lists existing admin tools and recovers keyboard focus after clearing a search", async () => {
    const { container } = renderInRouter(<Directory />);
    await screen.findByText("Research and administration");
    const destinations = Array.from(document.querySelectorAll("li a"), (link) =>
      link.getAttribute("href"),
    );
    const existingTools = ADMIN_SECTIONS.flatMap((section) => section.items.map((item) => item.to));
    expect(destinations.sort()).toEqual(
      [...existingTools.filter((to) => to !== "/admin"), "/research-lab"].sort(),
    );
    const search = screen.getByLabelText("Find a tool");
    fireEvent.change(search, { target: { value: "ketamine exposure" } });
    expect(container.querySelector('a[href="/ketamine"]')).toHaveTextContent("Ketamine signature");
    expect(container.querySelector('a[href="/admin/people"]')).toBeNull();
    fireEvent.change(search, { target: { value: "no such tool" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching tools");
    fireEvent.click(screen.getByLabelText("Clear tool search"));
    expect(search).toHaveFocus();
    expect(container.querySelector('a[href="/admin/people"]')).toHaveTextContent("People");
  });

  it("opens the admin drawer with a keyboard and returns focus on Escape", async () => {
    const user = userEvent.setup();
    renderInRouter(
      <AdminShell>
        <p>Test content</p>
      </AdminShell>,
    );
    const trigger = await screen.findByRole("button", { name: "Open admin menu" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const drawer = await screen.findByRole("dialog", { name: "Administration" });
    expect(within(drawer).getByRole("link", { name: "Ketamine signature" })).toHaveAttribute(
      "href",
      "/ketamine",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("requires an app session and server-verified admin privileges at the route boundaries", async () => {
    const clinicianGate = PrivateRoute.options.beforeLoad!;
    const adminGate = AdminRoute.options.beforeLoad!;
    state.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(clinicianGate({ location: { pathname: "/" } } as never)).rejects.toMatchObject({
      options: { to: "/auth" },
    });
    state.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(
      clinicianGate({ location: { pathname: "/settings" } } as never),
    ).rejects.toMatchObject({
      options: { to: "/auth", search: { setup: "passkey" } },
    });
    state.getUser.mockResolvedValueOnce({ data: { user: { id: "researcher" } }, error: null });
    await expect(clinicianGate({ location: { pathname: "/" } } as never)).resolves.toEqual({
      user: { id: "researcher" },
    });
    state.assertAdmin.mockRejectedValueOnce(new Error("No application role"));
    await expect(adminGate({} as never)).rejects.toMatchObject({ options: { to: "/" } });
    state.assertAdmin.mockResolvedValueOnce(undefined);
    await expect(adminGate({} as never)).resolves.toBeUndefined();
  });
});
