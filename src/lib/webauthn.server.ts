import { getRequest } from "@tanstack/react-start/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

export function getRelyingParty() {
  const request = getRequest();
  const origin =
    request?.headers.get("origin") ?? (request?.url ? new URL(request.url).origin : undefined);
  if (!origin) throw new Error("Unable to determine request origin");
  const rpID = new URL(origin).hostname;
  return { origin, rpID };
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
  await db.from("webauthn_challenges").delete().eq("email", email).eq("purpose", purpose);
  const { error } = await db.from("webauthn_challenges").insert({ email, challenge, purpose });
  if (error) throw error;
}

async function takeChallenge(email: string, purpose: string) {
  const db = await admin();
  const { data, error } = await db
    .from("webauthn_challenges")
    .select("id, challenge, expires_at")
    .eq("email", email)
    .eq("purpose", purpose)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Challenge expired - please try again.");
  await db.from("webauthn_challenges").delete().eq("id", data.id);
  if (new Date(data.expires_at).getTime() < Date.now()) {
    throw new Error("Challenge expired - please try again.");
  }
  return data.challenge;
}

export async function buildRegistrationOptions(userId: string, email: string) {
  const { rpID } = getRelyingParty();
  const db = await admin();
  const { data: existing } = await db
    .from("webauthn_credentials")
    .select("credential_id, transports")
    .eq("user_id", userId);

  const options = await generateRegistrationOptions({
    rpName: "CortexTrace",
    rpID,
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
  const expectedChallenge = await takeChallenge(normaliseEmail(email), "register");

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
    public_key: Buffer.from(credential.publicKey).toString("base64url"),
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
  const { data: users } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const user = users?.users.find((u) => u.email?.toLowerCase() === email);

  let allow: { id: string; transports?: string[] }[] = [];
  if (user) {
    const { data } = await db
      .from("webauthn_credentials")
      .select("credential_id, transports")
      .eq("user_id", user.id);
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
  const expectedChallenge = await takeChallenge(email, "authenticate");

  const db = await admin();
  const credentialId = String((response as { id?: string }).id ?? "");
  const { data: stored } = await db
    .from("webauthn_credentials")
    .select("*")
    .eq("credential_id", credentialId)
    .maybeSingle();
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
      publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64url")),
      counter: Number(stored.counter),
      transports: (stored.transports ?? []) as never,
    },
  });

  if (!verification.verified) throw new Error("Passkey verification failed.");

  await db
    .from("webauthn_credentials")
    .update({
      counter: verification.authenticationInfo.newCounter,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", stored.id);

  const { data: link, error: linkError } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link?.properties?.hashed_token) {
    throw new Error("Could not start a session for this passkey.");
  }

  return { tokenHash: link.properties.hashed_token };
}
