import { getRequest } from "@tanstack/react-start/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

import { decodeClientDataJSON, isoBase64URL } from "@simplewebauthn/server/helpers";

export function getRelyingParty() {
  const request = getRequest();
  if (!request?.url) throw new Error("Unable to determine the passkey origin.");
  const destination = new URL(request.url).origin;
  const origin = request.headers.get("origin") ?? destination;
  // A reverse proxy can expose its internal URL to the server. The published
  // app origin is stable; custom deployments can supply their own exact allowlist.
  const configured = (process.env["WEBAUTHN_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = configured.length
    ? configured
    : [destination, "https://muse-brain-insight.lovable.app"];
  if (!allowed.includes(origin)) {
    throw new Error("Open the app at its registered passkey address.");
  }
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== origin ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  ) {
    throw new Error("Passkeys require the app's secure origin.");
  }
  return { origin, rpID: url.hostname };
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function normaliseEmail(email: string) {
  return email.trim().toLowerCase();
}

async function storeChallenge(email: string, challenge: string, purpose: string) {
  const db = await admin();
  const { error: cleanupError } = await db
    .from("webauthn_challenges")
    .delete()
    .eq("email", email)
    .eq("purpose", purpose)
    .lt("expires_at", new Date().toISOString());
  if (cleanupError) throw cleanupError;
  const { error } = await db.from("webauthn_challenges").insert({ email, challenge, purpose });
  if (error) throw error;
}

async function takeChallenge(email: string, purpose: string, response: Record<string, unknown>) {
  const clientData = (response["response"] as { clientDataJSON?: unknown } | null)?.clientDataJSON;
  if (typeof clientData !== "string") throw new Error("Missing passkey response.");
  // This value only selects a server-generated challenge. The verifier below
  // independently checks the signed browser response and the expected challenge.
  const { challenge } = decodeClientDataJSON(clientData);
  if (typeof challenge !== "string" || !challenge) throw new Error("Missing passkey challenge.");
  const db = await admin();
  const { data, error } = await db
    .from("webauthn_challenges")
    .delete()
    .eq("email", email)
    .eq("purpose", purpose)
    .eq("challenge", challenge)
    .gt("expires_at", new Date().toISOString())
    .select("challenge")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Challenge expired or already used. Please try again.");
  return data.challenge;
}

export async function buildRegistrationOptions(userId: string, email: string) {
  const { rpID } = getRelyingParty();
  const db = await admin();
  const { data: existing, error } = await db
    .from("webauthn_credentials")
    .select("credential_id, transports")
    .eq("user_id", userId);
  if (error) throw error;

  const options = await generateRegistrationOptions({
    rpName: "CortexTrace",
    rpID,
    userID: new TextEncoder().encode(userId),
    userName: email,
    userDisplayName: email,
    attestationType: "none",
    excludeCredentials: (existing ?? []).map((c) => ({ id: c.credential_id })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
      authenticatorAttachment: "platform",
    },
  });

  await storeChallenge(normaliseEmail(email), options.challenge, "register");
  return options;
}

export async function saveRegistration(
  userId: string,
  email: string,
  response: Record<string, unknown>,
  label: string,
) {
  const { origin, rpID } = getRelyingParty();
  const expectedChallenge = await takeChallenge(normaliseEmail(email), "register", response);

  const verification = await verifyRegistrationResponse({
    response: response as never,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey registration could not be verified.");
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  const db = await admin();
  const { error } = await db.from("webauthn_credentials").insert({
    user_id: userId,
    credential_id: credential.id,
    public_key: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? [],
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp,
    label,
  });
  if (error) throw error;
  return { ok: true as const };
}

export async function buildAuthenticationOptions(rawEmail: string) {
  const email = normaliseEmail(rawEmail);
  const { rpID } = getRelyingParty();
  const db = await admin();
  let userId: string | undefined;
  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    userId = data.users.find((user) => user.email?.toLowerCase() === email)?.id;
    if (userId || data.users.length < perPage || (data.total > 0 && page * perPage >= data.total))
      break;
  }

  let allow: { id: string; transports?: string[] }[] = [];
  if (userId) {
    const { data, error } = await db
      .from("webauthn_credentials")
      .select("credential_id, transports")
      .eq("user_id", userId);
    if (error) throw error;
    allow = (data ?? []).map((c) => ({ id: c.credential_id, transports: c.transports }));
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: allow as never,
  });

  await storeChallenge(email, options.challenge, "authenticate");
  return options;
}

export async function verifyAuthenticationAndMint(
  rawEmail: string,
  response: Record<string, unknown>,
) {
  const email = normaliseEmail(rawEmail);
  const { origin, rpID } = getRelyingParty();
  const expectedChallenge = await takeChallenge(email, "authenticate", response);

  const db = await admin();
  const credentialId = String((response as { id?: string }).id ?? "");
  const { data: stored, error: lookupError } = await db
    .from("webauthn_credentials")
    .select("*")
    .eq("credential_id", credentialId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (!stored) throw new Error("This passkey is not registered.");

  const { data: userLookup } = await db.auth.admin.getUserById(stored.user_id);
  if (!userLookup?.user || userLookup.user.email?.toLowerCase() !== email) {
    throw new Error("This passkey does not belong to that account.");
  }

  const verification = await verifyAuthenticationResponse({
    response: response as never,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: stored.credential_id,
      publicKey: isoBase64URL.toBuffer(stored.public_key),
      counter: Number(stored.counter),
      transports: (stored.transports ?? []) as never,
    },
  });

  if (!verification.verified) throw new Error("Passkey verification failed.");

  const { data: updated, error: updateError } = await db
    .from("webauthn_credentials")
    .update({
      counter: verification.authenticationInfo.newCounter,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", stored.id)
    .eq("counter", stored.counter)
    .select("id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new Error("The passkey changed during sign-in. Please try again.");

  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link?.properties?.hashed_token || link.user?.id !== stored.user_id) {
    throw new Error("Could not start a session for this passkey.");
  }

  return { tokenHash: link.properties.hashed_token };
}
