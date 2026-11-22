import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Route as AuthRoute } from "@/routes/auth";
import { PUBLISHED_PASSKEY_ORIGIN } from "@/lib/webauthn-support";

const state = vi.hoisted(() => ({
  start: vi.fn(),
  prompt: vi.fn(),
  finish: vi.fn(),
  exchange: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@simplewebauthn/browser", () => ({ startAuthentication: state.prompt }));
vi.mock("@/lib/webauthn.functions", () => ({
  startPasskeyLogin: state.start,
  finishPasskeyLogin: state.finish,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { verifyOtp: state.exchange } },
}));
vi.mock("@/integrations/lovable/index", () => ({ lovable: {} }));
vi.mock("sonner", () => ({ toast: { error: state.error } }));

function openSignIn() {
  const Auth = AuthRoute.options.component!;
  const routeTree = createRootRoute({ component: Auth });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}
async function pressPasskey(email = "Clinician@example.org") {
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: class {} });
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: { isActive: true },
  });
  state.start.mockResolvedValue({ challenge: "one-use" });
  state.prompt.mockResolvedValue({ id: "device-response" });
  state.finish.mockResolvedValue({ tokenHash: "fixture-only" });
  state.exchange.mockResolvedValue({ data: { session: { user: { id: "example" } } }, error: null });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "userActivation");
  Reflect.deleteProperty(document, "featurePolicy");
  vi.unstubAllGlobals();
});
describe("passkey sign-in", { timeout: 30_000 }, () => {
  it("completes the device ceremony and exchanges its verified token without a password", async () => {
    openSignIn();
    await pressPasskey();
    await waitFor(() =>
      expect(state.exchange).toHaveBeenCalledWith({
        token_hash: "fixture-only",
        type: "magiclink",
      }),
    );
    expect(state.start).toHaveBeenCalledWith({ data: { email: "clinician@example.org" } });
    expect(state.finish).toHaveBeenCalledWith({
      data: { email: "clinician@example.org", response: { id: "device-response" } },
    });
  });
  it("waits for a fresh gesture when challenge retrieval consumed the original tap", async () => {
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
    });
    openSignIn();
    await pressPasskey();
    fireEvent.click(await screen.findByRole("button", { name: "Continue with passkey" }));
    await waitFor(() => expect(state.exchange).toHaveBeenCalledOnce());
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.prompt).toHaveBeenCalledOnce();
  });
  it("lets the user retry a dismissed login prompt and keeps password sign-in available", async () => {
    state.prompt.mockRejectedValueOnce(new DOMException("Dismissed", "NotAllowedError"));
    openSignIn();
    await pressPasskey();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The passkey prompt did not complete",
    );
    expect(state.finish).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in with password" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(state.exchange).toHaveBeenCalledOnce());
  });
  it("offers the published top-level sign-in in a blocked editor without requesting a challenge", async () => {
    vi.stubGlobal("self", {});
    Object.defineProperty(document, "featurePolicy", {
      configurable: true,
      value: { allowsFeature: () => false },
    });
    openSignIn();
    const link = await screen.findByRole("link", { name: /open published app for Face ID/i });
    expect(link).toHaveAttribute("href", PUBLISHED_PASSKEY_ORIGIN + "/auth");
    expect(link).toHaveAttribute("target", "_blank");
    expect(state.start).not.toHaveBeenCalled();
  });
  it("shows a session error when the token exchange yields no session", async () => {
    state.exchange.mockResolvedValueOnce({ data: { session: null }, error: null });
    openSignIn();
    await pressPasskey();
    expect(await screen.findByRole("alert")).toHaveTextContent("The server rejected the passkey");
  });
});
