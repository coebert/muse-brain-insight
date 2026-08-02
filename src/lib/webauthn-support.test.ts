import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import {
  getPasskeyEnvironment,
  describePasskeyFailure,
  summarisePasskeyFailure,
} from "./webauthn-support";

function setEmbedded(embedded: boolean) {
  Object.defineProperty(window, "self", {
    value: embedded ? ({} as Window) : window,
    configurable: true,
  });
  Object.defineProperty(window, "top", { value: window, configurable: true });
}

function setFeaturePolicy(allows: boolean | null) {
  if (allows === null) {
    Reflect.deleteProperty(document as object, "featurePolicy");
    return;
  }
  Object.defineProperty(document, "featurePolicy", {
    value: { allowsFeature: () => allows },
    configurable: true,
  });
}

describe("getPasskeyEnvironment", () => {
  beforeEach(() => {
    Object.defineProperty(window, "PublicKeyCredential", {
      value: function PublicKeyCredential() {},
      configurable: true,
    });
    setEmbedded(false);
    setFeaturePolicy(null);
  });

  afterEach(() => {
    setEmbedded(false);
    setFeaturePolicy(null);
  });

  it("reports a supported, top-level page as ready for enrollment", () => {
    const env = getPasskeyEnvironment();
    expect(env.supported).toBe(true);
    expect(env.embedded).toBe(false);
    expect(env.allowedToCreate).toBe(true);
    expect(env.standaloneUrl).toContain("http");
  });

  it("flags an iframe whose permissions policy blocks credential creation", () => {
    setEmbedded(true);
    setFeaturePolicy(false);
    const env = getPasskeyEnvironment();
    expect(env.embedded).toBe(true);
    expect(env.allowedToCreate).toBe(false);
  });

  it("allows an iframe that explicitly delegates the permission", () => {
    setEmbedded(true);
    setFeaturePolicy(true);
    expect(getPasskeyEnvironment().allowedToCreate).toBe(true);
  });

  it("reports unsupported when the WebAuthn API is missing", () => {
    Reflect.deleteProperty(window as object, "PublicKeyCredential");
    expect(getPasskeyEnvironment().supported).toBe(false);
  });
});

describe("describePasskeyFailure", () => {
  it("explains the blocked-iframe case with an open-in-new-tab step", () => {
    const failure = describePasskeyFailure(
      new DOMException("blocked by permissions policy", "NotAllowedError"),
      { supported: true, embedded: true, allowedToCreate: false, standaloneUrl: "https://x.test" },
    );
    expect(failure.code).toBe("blocked");
    expect(failure.suggestNewTab).toBe(true);
    expect(failure.explanation).toMatch(/embedded preview frame/i);
    expect(failure.reason).toContain("NotAllowedError");
    expect(failure.reason).toContain("blocked by permissions policy");
    expect(failure.steps.length).toBeGreaterThan(0);
  });

  it("distinguishes a dismissed prompt outside an iframe", () => {
    const failure = describePasskeyFailure(
      new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"),
      { supported: true, embedded: false, allowedToCreate: true, standaloneUrl: "https://x.test" },
    );
    expect(failure.code).toBe("blocked");
    expect(failure.explanation).not.toMatch(/embedded preview frame/i);
  });

  it("detects an already-registered authenticator", () => {
    const failure = describePasskeyFailure(new DOMException("exists", "InvalidStateError"));
    expect(failure.code).toBe("duplicate");
    expect(failure.suggestNewTab).toBe(false);
  });

  it("detects origin / relying-party mismatches", () => {
    const failure = describePasskeyFailure(new DOMException("bad rpId", "SecurityError"));
    expect(failure.code).toBe("insecure-origin");
    expect(failure.suggestNewTab).toBe(true);
  });

  it("classifies cancellation, timeout and unsupported authenticators", () => {
    expect(describePasskeyFailure(new DOMException("x", "AbortError")).code).toBe("cancelled");
    expect(describePasskeyFailure(new DOMException("x", "TimeoutError")).code).toBe("timeout");
    expect(describePasskeyFailure(new DOMException("x", "NotSupportedError")).code).toBe(
      "unsupported",
    );
  });

  it("classifies transport and server-side verification errors", () => {
    expect(describePasskeyFailure(new TypeError("Failed to fetch")).code).toBe("network");
    expect(describePasskeyFailure(new Error("Challenge expired")).code).toBe("server");
    expect(describePasskeyFailure(new Error("Passkey could not be verified")).code).toBe("server");
  });

  it("falls back to an unknown classification but still surfaces the exact reason", () => {
    const failure = describePasskeyFailure(new Error("kaboom"));
    expect(failure.code).toBe("unknown");
    expect(failure.reason).toBe("Error: kaboom");
  });

  it("handles non-Error throwables", () => {
    expect(describePasskeyFailure("plain string").reason).toBe("plain string");
  });

  it("summarises a failure into a single actionable line", () => {
    const failure = describePasskeyFailure(new DOMException("x", "AbortError"));
    expect(summarisePasskeyFailure(failure)).toContain(failure.title);
    expect(summarisePasskeyFailure(failure)).toContain(failure.steps[0]!);
  });
});
