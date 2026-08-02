export type PasskeyEnvironment = {
  /** Browser exposes the WebAuthn API at all. */
  supported: boolean;
  /** Page is running inside an iframe (Lovable preview) — WebAuthn is usually blocked. */
  embedded: boolean;
  /** Permissions-Policy actually allows creating a credential here. */
  allowedToCreate: boolean;
  /** Standalone URL the user should open to register a passkey. */
  standaloneUrl: string;
};

function permissionAllowed(feature: string): boolean {
  const fp = (document as unknown as { featurePolicy?: { allowsFeature: (f: string) => boolean } })
    .featurePolicy;
  try {
    return fp ? fp.allowsFeature(feature) : true;
  } catch {
    return true;
  }
}

export function getPasskeyEnvironment(): PasskeyEnvironment {
  const supported = typeof window !== "undefined" && !!window.PublicKeyCredential;
  const embedded = typeof window !== "undefined" && window.self !== window.top;
  const allowedToCreate = !embedded || permissionAllowed("publickey-credentials-create");
  return {
    supported,
    embedded,
    allowedToCreate,
    standaloneUrl: typeof window !== "undefined" ? window.location.href : "",
  };
}

export function describePasskeyFailure(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  if (/NotAllowedError/i.test(name) || /not allowed|permissions policy/i.test(message)) {
    return "Your browser blocked the passkey prompt. Open the app in its own browser tab (not inside the preview frame) and try again.";
  }
  if (/InvalidStateError/i.test(name)) {
    return "This device already has a passkey registered for your account.";
  }
  if (/SecurityError/i.test(name)) {
    return "Passkeys require the app to run on its own secure domain. Open the published app URL and try again.";
  }
  if (/AbortError/i.test(name)) {
    return "Passkey setup was cancelled.";
  }
  return message || "Could not add passkey.";
}
