// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import virtualPasskey from "../test/fixtures/ctap2-passkey.json";

import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  getRelyingParty,
  saveRegistration,
  verifyAuthenticationAndMint,
} from "./webauthn.server";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  from: vi.fn(),
  listUsers: vi.fn(),
  getUserById: vi.fn(),
  generateLink: vi.fn(),
  generateRegistration: vi.fn(),
  generateAuthentication: vi.fn(),
  verifyRegistration: vi.fn(),
  verifyAuthentication: vi.fn(),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.request }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    auth: {
      admin: {
        listUsers: mocks.listUsers,
        getUserById: mocks.getUserById,
        generateLink: mocks.generateLink,
      },
    },
  },
}));
vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: mocks.generateAuthentication,
  generateRegistrationOptions: mocks.generateRegistration,
  verifyAuthenticationResponse: mocks.verifyAuthentication,
  verifyRegistrationResponse: mocks.verifyRegistration,
}));

const canonical = "https://muse-brain-insight.lovable.app";
const email = "clinician@example.test";
const userId = "fixture-account";
const challenge = "fixture-challenge";
const credential = {
  id: "row-1",
  credential_id: "fixture-credential",
  user_id: userId,
  public_key: "AQID",
  counter: 2,
  transports: ["internal"],
};
const response = {
  id: credential.credential_id,
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: canonical }),
    ).toString("base64url"),
  },
};

function query(data: unknown = null, error: unknown = null) {
  const result = { data, error };
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  mocks.from.mockReturnValueOnce(chain);
  return chain;
}

function authenticationQueries(updated: unknown = { id: credential.id }, error: unknown = null) {
  const consumed = query({ challenge });
  query(credential);
  const saved = query(updated, error);
  mocks.getUserById.mockResolvedValue({ data: { user: { id: userId, email } } });
  mocks.verifyAuthentication.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 3 },
  });
  mocks.generateLink.mockResolvedValue({
    data: { user: { id: userId }, properties: { hashed_token: "fixture-token" } },
  });
  return { consumed, saved };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WEBAUTHN_ORIGINS", "");
  mocks.request.mockReturnValue(
    new Request(canonical + "/auth", { headers: { Origin: canonical } }),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("passkey relying party", () => {
  it("retains the exact published hostname behind a proxy", () => {
    mocks.request.mockReturnValue(
      new Request("http://internal.test/auth", { headers: { Origin: canonical } }),
    );
    expect(getRelyingParty()).toEqual({
      origin: canonical,
      rpID: "muse-brain-insight.lovable.app",
    });
  });

  it("uses only exact configured custom origins", () => {
    vi.stubEnv("WEBAUTHN_ORIGINS", "https://research.example.test");
    mocks.request.mockReturnValue(
      new Request("http://internal.test/auth", {
        headers: { Origin: "https://research.example.test" },
      }),
    );
    expect(getRelyingParty()).toEqual({
      origin: "https://research.example.test",
      rpID: "research.example.test",
    });
    mocks.request.mockReturnValue(
      new Request(canonical + "/auth", { headers: { Origin: canonical } }),
    );
    expect(() => getRelyingParty()).toThrow("registered passkey address");
  });

  it("rejects unrelated browser origins and non-local HTTP", () => {
    mocks.request.mockReturnValue(
      new Request(canonical + "/auth", { headers: { Origin: "https://other.example.test" } }),
    );
    expect(() => getRelyingParty()).toThrow("registered passkey address");
    mocks.request.mockReturnValue(new Request("http://research.example.test/auth"));
    expect(() => getRelyingParty()).toThrow("secure origin");
  });
});

describe("passkey ceremonies", () => {
  it("verifies an enrolled virtual credential and its signed assertion with the real verifier", async () => {
    // These public test responses came from one isolated NID CTAP2 ceremony.
    // The signing key existed only in the virtual authenticator's memory.
    const real = await vi.importActual<typeof import("@simplewebauthn/server")>("@simplewebauthn/server");
    mocks.verifyRegistration.mockImplementationOnce(real.verifyRegistrationResponse);
    mocks.verifyAuthentication.mockImplementationOnce(real.verifyAuthenticationResponse);
    const { origin, userId, email } = virtualPasskey;
    mocks.request.mockReturnValue(new Request(origin + "/auth", { headers: { Origin: origin } }));

    query({ challenge: virtualPasskey.registrationChallenge });
    const enrollment = query();
    await saveRegistration(userId, email, virtualPasskey.registration, "Virtual platform test");
    const stored = enrollment.insert.mock.calls[0]![0];
    expect(stored).toMatchObject({ user_id: userId, credential_id: virtualPasskey.registration.id });

    query({ challenge: virtualPasskey.authenticationChallenge });
    query({ ...stored, id: "test-credential-row" });
    const saved = query({ id: "test-credential-row" });
    mocks.getUserById.mockResolvedValue({ data: { user: { id: userId, email } } });
    mocks.generateLink.mockResolvedValue({
      data: { user: { id: userId }, properties: { hashed_token: "test-session-handoff" } },
    });
    await expect(verifyAuthenticationAndMint(email, virtualPasskey.authentication)).resolves.toEqual({
      tokenHash: "test-session-handoff",
    });
    expect(saved.update).toHaveBeenCalledWith(expect.objectContaining({ last_used_at: expect.any(String) }));
    expect(mocks.generateLink).toHaveBeenCalledWith({ type: "magiclink", email });
  });

  it("finds enrolled credentials beyond the first account page without invalidating other tabs", async () => {
    mocks.listUsers
      .mockResolvedValueOnce({
        data: {
          users: Array.from({ length: 200 }, () => ({ id: "other", email: "other@example.test" })),
          total: 201,
        },
      })
      .mockResolvedValueOnce({ data: { users: [{ id: userId, email }], nextPage: null } });
    const credentials = query([credential]);
    const cleanup = query();
    const inserted = query();
    mocks.generateAuthentication.mockResolvedValue({ challenge });
    await buildAuthenticationOptions(" Clinician@example.test ");
    expect(mocks.listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 200 });
    expect(credentials.eq).toHaveBeenCalledWith("user_id", userId);
    expect(mocks.generateAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        userVerification: "required",
        allowCredentials: [{ id: credential.credential_id, transports: ["internal"] }],
      }),
    );
    expect(cleanup.lt).toHaveBeenCalledWith("expires_at", expect.any(String));
    expect(inserted.insert).toHaveBeenCalledWith({ email, challenge, purpose: "authenticate" });
  });

  it("uses a stable account handle and requires verification on platform registration", async () => {
    query([]);
    query();
    query();
    mocks.generateRegistration.mockResolvedValue({ challenge });
    await buildRegistrationOptions(userId, email);
    expect(mocks.generateRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        userID: new TextEncoder().encode(userId),
        rpID: "muse-brain-insight.lovable.app",
        authenticatorSelection: expect.objectContaining({
          authenticatorAttachment: "platform",
          userVerification: "required",
        }),
      }),
    );
    query({ challenge });
    const saved = query();
    mocks.verifyRegistration.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: credential.credential_id,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
        },
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
      },
    });
    const registrationResponse = {
      ...response,
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({ type: "webauthn.create", challenge, origin: canonical }),
        ).toString("base64url"),
      },
    };
    await expect(
      saveRegistration(userId, email, registrationResponse, "Fixture device"),
    ).resolves.toEqual({
      ok: true,
    });
    expect(mocks.verifyRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: challenge,
        expectedOrigin: canonical,
        expectedRPID: "muse-brain-insight.lovable.app",
        requireUserVerification: true,
      }),
    );
    expect(saved.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: userId, public_key: "AQID" }),
    );
  });

  it("atomically consumes the matching challenge and persists the counter before issuing a session", async () => {
    const { consumed, saved } = authenticationQueries();
    await expect(verifyAuthenticationAndMint(email, response)).resolves.toEqual({
      tokenHash: "fixture-token",
    });
    expect(consumed.delete).toHaveBeenCalled();
    for (const [key, value] of [
      ["email", email],
      ["purpose", "authenticate"],
      ["challenge", challenge],
    ]) {
      expect(consumed.eq).toHaveBeenCalledWith(key, value);
    }
    expect(consumed.gt).toHaveBeenCalledWith("expires_at", expect.any(String));
    expect(mocks.verifyAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: canonical,
        expectedRPID: "muse-brain-insight.lovable.app",
        expectedChallenge: challenge,
        requireUserVerification: true,
      }),
    );
    expect(saved.eq).toHaveBeenCalledWith("counter", 2);
    expect(saved.update).toHaveBeenCalledWith(expect.objectContaining({ counter: 3 }));
    expect(mocks.generateLink).toHaveBeenCalledWith({ type: "magiclink", email });
  });

  it("withholds the session when an issued token belongs to a different account", async () => {
    authenticationQueries();
    mocks.generateLink.mockResolvedValue({
      data: { user: { id: "other" }, properties: { hashed_token: "fixture-token" } },
    });
    await expect(verifyAuthenticationAndMint(email, response)).rejects.toThrow(
      "Could not start a session",
    );
  });

  it("stops on expired challenges and uncommitted counter updates", async () => {
    query(null);
    await expect(verifyAuthenticationAndMint(email, response)).rejects.toThrow(
      "expired or already used",
    );
    expect(mocks.verifyAuthentication).not.toHaveBeenCalled();
    authenticationQueries(null);
    await expect(verifyAuthenticationAndMint(email, response)).rejects.toThrow(
      "changed during sign-in",
    );
    expect(mocks.generateLink).not.toHaveBeenCalled();
  });
});
