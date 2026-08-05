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

export interface PasskeyFailure {
  /** Short headline for the notice. */
  title: string;
  /** Plain-language explanation of what the browser actually reported. */
  explanation: string;
  /** Exact technical reason: DOMException name and message, or thrown text. */
  reason: string;
  /** Ordered troubleshooting steps for this specific failure. */
  steps: string[];
  /** True when opening the app in its own tab is the likely fix. */
  suggestNewTab: boolean;
  /** Stable code for logs/telemetry. */
  code:
    | "blocked"
    | "duplicate"
    | "insecure-origin"
    | "cancelled"
    | "timeout"
    | "unsupported"
    | "network"
    | "server"
    | "unknown";
}

/** Extract the exact browser-reported reason, including DOMException name. */
function exactReason(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { name?: string; message?: string; cause?: unknown };
    const name = e.name ?? "Error";
    const message = e.message ?? String(err);
    const cause =
      e.cause && typeof e.cause === "object"
        ? ` (cause: ${(e.cause as { message?: string }).message ?? String(e.cause)})`
        : "";
    return `${name}: ${message}${cause}`;
  }
  return String(err);
}

/** Classify a WebAuthn/registration error into an actionable notice. */
export function describePasskeyFailure(err: unknown, env?: PasskeyEnvironment): PasskeyFailure {
  const reason = exactReason(err);
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  const embedded = env?.embedded ?? false;

  if (/NotAllowedError/i.test(name) || /permissions policy|not allowed/i.test(message)) {
    return {
      title: "The browser blocked the passkey prompt",
      explanation: embedded
        ? "Passkey creation is disabled inside the embedded preview frame, so the prompt never reached your device."
        : "The prompt was refused or dismissed before your device could confirm it. This is also what you see if the page lost focus, or if the browser's permissions policy disallows passkeys here.",
      reason,
      steps: [
        "Open CortexTrace in its own browser tab (not inside an embedded frame).",
        "Keep the tab focused while the Face ID / Touch ID / Windows Hello prompt is showing.",
        "Confirm your device has a screen lock or biometric enrolled in the operating system.",
        "Try again — if the prompt still never appears, check your browser's site permissions for this domain.",
      ],
      suggestNewTab: true,
      code: "blocked",
    };
  }

  if (/InvalidStateError/i.test(name)) {
    return {
      title: "This device already has a passkey for your account",
      explanation:
        "The authenticator refused to create a second credential because one for this account already exists on it.",
      reason,
      steps: [
        "Go back to sign-in and use Face ID / Touch ID with the existing passkey.",
        "If you want a fresh one, delete the existing passkey from the list below, then add it again.",
        "Also remove the stale entry from your device or password manager's passkey list.",
      ],
      suggestNewTab: false,
      code: "duplicate",
    };
  }

  if (/SecurityError/i.test(name) || /relying party|rpid|origin/i.test(message)) {
    return {
      title: "The page origin does not match the passkey domain",
      explanation:
        "Passkeys are bound to one domain over HTTPS. The current address does not satisfy that, so the browser refused the request.",
      reason,
      steps: [
        "Open the published app URL directly (https://muse-brain-insight.lovable.app) rather than a preview or proxy address.",
        "Do not use an IP address or a non-HTTPS URL.",
        "Passkeys added on one domain cannot be used on another — re-register on the domain you sign in from.",
      ],
      suggestNewTab: true,
      code: "insecure-origin",
    };
  }

  if (/AbortError/i.test(name)) {
    return {
      title: "Passkey setup was cancelled",
      explanation: "The request was aborted — usually by dismissing the prompt or navigating away.",
      reason,
      steps: [
        "Click Add passkey again and complete the device prompt without switching tabs or apps.",
      ],
      suggestNewTab: false,
      code: "cancelled",
    };
  }

  if (/TimeoutError/i.test(name) || /timed? ?out/i.test(message)) {
    return {
      title: "The device prompt timed out",
      explanation: "Your authenticator did not respond within the allowed time window.",
      reason,
      steps: [
        "Try again and confirm the biometric or PIN prompt straight away.",
        "If you are using a security key, insert and tap it as soon as the prompt appears.",
      ],
      suggestNewTab: false,
      code: "timeout",
    };
  }

  if (
    /NotSupportedError/i.test(name) ||
    /not supported|no available authenticator/i.test(message)
  ) {
    return {
      title: "No usable authenticator on this device",
      explanation:
        "The browser could not find a platform authenticator (Face ID, Touch ID, Windows Hello) that meets the required settings.",
      reason,
      steps: [
        "Enable a screen lock and biometric unlock in your operating system settings.",
        "Use a current version of Safari, Chrome or Edge.",
        "Otherwise sign in with your email and password — passkeys are optional.",
      ],
      suggestNewTab: false,
      code: "unsupported",
    };
  }

  if (/Failed to fetch|NetworkError|load failed/i.test(message)) {
    return {
      title: "Could not reach the CortexTrace server",
      explanation:
        "The passkey challenge could not be requested or verified because the network call failed.",
      reason,
      steps: [
        "Check your connection and try again.",
        "If you are on hospital Wi-Fi, confirm the app domain is not blocked by the proxy.",
      ],
      suggestNewTab: false,
      code: "network",
    };
  }

  if (/challenge expired/i.test(message)) {
    return {
      title: "The passkey challenge expired",
      explanation:
        "Registration challenges are single-use and short-lived; this one was already used or timed out.",
      reason,
      steps: ["Click Add passkey again and complete the prompt within a minute."],
      suggestNewTab: false,
      code: "server",
    };
  }

  if (
    /could not be verified|not registered|does not belong|verification failed|session/i.test(
      message,
    )
  ) {
    return {
      title: "The server rejected the passkey",
      explanation: "The signature or account link could not be verified server-side.",
      reason,
      steps: [
        "Make sure you are signing in with the same email the passkey was registered to.",
        "Delete the passkey and register it again from this device.",
        "If it keeps failing, sign in with your password and report the exact reason below.",
      ],
      suggestNewTab: false,
      code: "server",
    };
  }

  return {
    title: "Passkey setup did not complete",
    explanation: "The browser returned an unexpected error.",
    reason,
    steps: [
      "Try again in a fresh browser tab.",
      "Check that your device has a biometric or PIN enrolled.",
      "If it persists, copy the exact reason below so it can be diagnosed.",
    ],
    suggestNewTab: false,
    code: "unknown",
  };
}

/** One-line summary suitable for a toast. */
export function summarisePasskeyFailure(failure: PasskeyFailure): string {
  return `${failure.title} — ${failure.steps[0] ?? "See the notice for next steps."}`;
}
