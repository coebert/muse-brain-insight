import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PasskeyManager } from "./PasskeyManager";

const startRegistration = vi.fn();
const startPasskeyRegistration = vi.fn();
const finishPasskeyRegistration = vi.fn();
const deleteEq = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

let storedKeys: Array<Record<string, unknown>> = [];

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: (...args: unknown[]) => startRegistration(...args),
}));

vi.mock("@/lib/webauthn.functions", () => ({
  startPasskeyRegistration: (...args: unknown[]) => startPasskeyRegistration(...args),
  finishPasskeyRegistration: (...args: unknown[]) => finishPasskeyRegistration(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ order: async () => ({ data: storedKeys, error: null }) }),
      delete: () => ({ eq: (...args: unknown[]) => deleteEq(...args) }),
    }),
  },
}));

function setEnvironment({ supported = true, embedded = false, policyAllows = true } = {}) {
  if (supported) {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: function PublicKeyCredential() {},
      configurable: true,
    });
  } else {
    Reflect.deleteProperty(window as object, "PublicKeyCredential");
  }
  Object.defineProperty(window, "self", {
    value: embedded ? ({} as Window) : window,
    configurable: true,
  });
  Object.defineProperty(window, "top", { value: window, configurable: true });
  Object.defineProperty(document, "featurePolicy", {
    value: { allowsFeature: () => policyAllows },
    configurable: true,
  });
}

describe("PasskeyManager integration", () => {
  beforeEach(() => {
    storedKeys = [];
    deleteEq.mockResolvedValue({ error: null });
    setEnvironment();
  });

  it("completes enrollment end to end and lists the new passkey", async () => {
    const user = userEvent.setup();
    startPasskeyRegistration.mockResolvedValue({ challenge: "abc" });
    startRegistration.mockResolvedValue({ id: "cred-1", rawId: "cred-1" });
    finishPasskeyRegistration.mockImplementation(async () => {
      storedKeys = [
        {
          id: "row-1",
          label: "This device",
          created_at: "2026-08-01T10:00:00Z",
          last_used_at: null,
        },
      ];
      return { ok: true };
    });

    render(<PasskeyManager />);
    await user.click(screen.getByRole("button", { name: /add passkey/i }));

    await waitFor(() => expect(finishPasskeyRegistration).toHaveBeenCalled());
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "abc" } });
    expect(toastSuccess).toHaveBeenCalled();
    expect(await screen.findByText("This device")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("blocks enrollment inside an iframe and explains the unsupported-frame case", async () => {
    const user = userEvent.setup();
    setEnvironment({ embedded: true, policyAllows: false });

    render(<PasskeyManager />);
    await user.click(screen.getByRole("button", { name: /add passkey/i }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/blocked the passkey prompt/i);
    expect(notice).toHaveTextContent(/own browser tab/i);
    expect(startPasskeyRegistration).not.toHaveBeenCalled();
    expect(screen.getAllByRole("link", { name: /open in a new tab/i }).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /show exact reason/i }));
    expect(await screen.findByText(/publickey-credentials-create/i)).toBeInTheDocument();
    expect(screen.getByText(/NotAllowedError/)).toBeInTheDocument();
  });

  it("explains an unsupported browser without calling the server", async () => {
    const user = userEvent.setup();
    setEnvironment({ supported: false });

    render(<PasskeyManager />);
    await user.click(screen.getByRole("button", { name: /add passkey/i }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/no usable authenticator/i);
    expect(startPasskeyRegistration).not.toHaveBeenCalled();
  });

  it("surfaces the exact reason when the authenticator already holds a credential", async () => {
    const user = userEvent.setup();
    startPasskeyRegistration.mockResolvedValue({ challenge: "abc" });
    startRegistration.mockRejectedValue(
      new DOMException("credential already registered", "InvalidStateError"),
    );

    render(<PasskeyManager />);
    await user.click(screen.getByRole("button", { name: /add passkey/i }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/already has a passkey/i);
    expect(toastError).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /show exact reason/i }));
    expect(
      await screen.findByText(/InvalidStateError: credential already registered/),
    ).toBeInTheDocument();
  });

  it("surfaces server verification failures from the finish step", async () => {
    const user = userEvent.setup();
    startPasskeyRegistration.mockResolvedValue({ challenge: "abc" });
    startRegistration.mockResolvedValue({ id: "cred-1" });
    finishPasskeyRegistration.mockRejectedValue(new Error("Challenge expired"));

    render(<PasskeyManager />);
    await user.click(screen.getByRole("button", { name: /add passkey/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/challenge expired/i);
  });

  it("lets a clinician delete an existing passkey", async () => {
    const user = userEvent.setup();
    storedKeys = [
      { id: "row-9", label: "iPhone", created_at: "2026-07-01T10:00:00Z", last_used_at: null },
    ];

    render(<PasskeyManager />);
    expect(await screen.findByText("iPhone")).toBeInTheDocument();

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(deleteEq).toHaveBeenCalledWith("id", "row-9"));
  });
});
