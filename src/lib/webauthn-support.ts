export type PasskeyOperation = "create" | "get";

export type PasskeyEnvironment = {
  supported: boolean;
  secure: boolean;
  embedded: boolean;
  allowedToCreate: boolean;
  allowedToGet: boolean;
  usePublishedOrigin: boolean;
  standaloneUrl: string;
};

export const PUBLISHED_PASSKEY_ORIGIN = "https://muse-brain-insight.lovable.app";

function allowsCredential(operation: PasskeyOperation) {
  type Policy = { allowsFeature: (name: string) => boolean };
  const page = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy };
  try {
    const policy = page.permissionsPolicy ?? page.featurePolicy;
    return policy?.allowsFeature("publickey-credentials-" + operation) ?? true;
  } catch {
    // Browsers without policy introspection report any denial at the actual ceremony.
    return true;
  }
}

function configuredOrigin(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function getPasskeyEnvironment(operation: PasskeyOperation = "create"): PasskeyEnvironment {
  const browser = typeof window !== "undefined";
  const secure = browser && window.isSecureContext !== false;
  const embedded = browser && window.self !== window.top;
  const preview = browser && window.location.hostname.endsWith(".imported.base44-preview.app");
  const host = browser ? window.location.origin : PUBLISHED_PASSKEY_ORIGIN;
  const configured = configuredOrigin(import.meta.env["VITE_PASSKEY_APP_ORIGIN"]);
  const destination =
    configured ?? (preview || embedded || !secure ? PUBLISHED_PASSKEY_ORIGIN : host);
  return {
    supported: secure && !!window.PublicKeyCredential,
    secure,
    embedded,
    allowedToCreate: browser && allowsCredential("create"),
    allowedToGet: browser && allowsCredential("get"),
    usePublishedOrigin: host !== destination && (preview || !!configured),
    standaloneUrl: destination + (operation === "create" ? "/settings" : "/auth"),
  };
}

export function passkeyPreflight(env: PasskeyEnvironment, operation: PasskeyOperation) {
  if (!env.secure)
    return describePasskeyFailure(
      new DOMException("A secure HTTPS origin is required.", "SecurityError"),
      env,
      operation,
    );
  const allowed = operation === "create" ? env.allowedToCreate : env.allowedToGet;
  if (!allowed)
    return describePasskeyFailure(
      new DOMException(
        "The page permissions policy blocks publickey-credentials-" + operation + ".",
        "NotAllowedError",
      ),
      env,
      operation,
    );
  if (env.usePublishedOrigin)
    return {
      title: "Open the published app for passkeys",
      explanation:
        "Passkeys use the app's sign-in domain. This address is separate from the published app.",
      steps: ["Open the published app in its own browser tab and continue there."],
      code: "insecure-origin" as const,
      reason: "The current address differs from the published passkey origin.",
      suggestNewTab: true,
    };
  if (!env.supported)
    return describePasskeyFailure(
      new DOMException("WebAuthn is unavailable in this browser.", "NotSupportedError"),
      env,
      operation,
    );
  return null;
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
export function describePasskeyFailure(
  err: unknown,
  env?: PasskeyEnvironment,
  operation: PasskeyOperation = "create",
): PasskeyFailure {
  const reason = exactReason(err);
  const exception = err as { name?: string; cause?: { name?: string }; code?: string } | null;
  const name = exception?.cause?.name ?? exception?.name ?? "";
  const message = err instanceof Error ? err.message : String(err);
  const embedded = env?.embedded ?? false;
  const action = operation === "create" ? "setup" : "sign-in";
  const retry =
    operation === "create" ? "Choose Add passkey again." : "Choose Sign in with a passkey again.";

  if (/NotAllowedError/i.test(name) || /permissions policy|not allowed/i.test(message)) {
    const denied = env && !(operation === "create" ? env.allowedToCreate : env.allowedToGet);
    return {
      title: denied
        ? "The browser blocked the passkey prompt"
        : "The passkey prompt did not complete",
      explanation: denied
        ? (embedded ? "The embedded preview frame" : "This page") +
          " has a permissions policy that blocks passkey " +
          action +
          "."
        : "The prompt may have been dismissed, timed out or could not find a matching passkey.",
      reason,
      steps:
        embedded || env?.usePublishedOrigin
          ? ["Open CortexTrace in its own browser tab and try again."]
          : denied
            ? [
                "Use your usual sign-in method. The site administrator can enable passkeys in the permissions policy.",
              ]
            : [
                retry,
                operation === "get"
                  ? "Use the same email and app domain where you added your passkey, or sign in with your password."
                  : "Keep the tab focused while your device asks for confirmation.",
              ],
      suggestNewTab: embedded || !!env?.usePublishedOrigin,
      code: "blocked",
    };
  }

  if (/InvalidStateError/i.test(name)) {
    return {
      title: "This device already has a passkey for your account",
      explanation:
        "The authenticator refused to create a second credential because one for this account already exists on it.",
      reason,
      steps: ["Go back to sign-in and use Face ID / Touch ID with the existing passkey."],
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
      steps: ["Open the published HTTPS app and use the same app domain for setup and sign-in."],
      suggestNewTab: true,
      code: "insecure-origin",
    };
  }

  if (/AbortError/i.test(name)) {
    return {
      title: "Passkey " + action + " was cancelled",
      explanation: "The request was aborted — usually by dismissing the prompt or navigating away.",
      reason,
      steps: [retry],
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
      suggestNewTab: embedded,
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
      explanation: "The single-use challenge has expired or has already been used.",
      reason,
      steps: [retry],
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
        "If it keeps failing, sign in with your password and report the exact reason below.",
      ],
      suggestNewTab: false,
      code: "server",
    };
  }

  return {
    title: "Passkey " + action + " did not complete",
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
