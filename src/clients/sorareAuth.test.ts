import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import {
  resetSorareClientForTests,
  sorareAuthenticationStatus,
  sorareGraphql,
} from "./sorare.js";

const original = {
  email: config.sorareEmail,
  passwordHash: config.sorarePasswordHash,
  aud: config.sorareJwtAud,
  apiKey: config.sorareApiKey,
  fetch: globalThis.fetch,
};

function configure(): void {
  config.sorareEmail = "account@example.test";
  config.sorarePasswordHash = `$2a$11$${"a".repeat(53)}`;
  config.sorareJwtAud = "test-audience";
  config.sorareApiKey = "test-api-key";
  resetSorareClientForTests();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signIn(token: string): Response {
  return json({
    data: {
      signIn: {
        currentUser: { slug: "manager" },
        jwtToken: {
          token,
          expiredAt: new Date(Date.now() + 120_000).toISOString(),
        },
        otpSessionChallenge: null,
        tcuToken: null,
        errors: [],
      },
    },
  });
}

test.after(() => {
  config.sorareEmail = original.email;
  config.sorarePasswordHash = original.passwordHash;
  config.sorareJwtAud = original.aud;
  config.sorareApiKey = original.apiKey;
  globalThis.fetch = original.fetch;
  resetSorareClientForTests();
});

test("uses documented Sorare JWT headers without exposing credentials in status", async () => {
  configure();
  const calls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return calls.length === 1 ? signIn("jwt-one") : json({ data: { value: 42 } });
  };

  const result = await sorareGraphql<{ value: number }>("query Test { value }", {});
  assert.deepEqual(result, { value: 42 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.get("authorization"), "Bearer jwt-one");
  assert.equal(calls[1].headers.get("jwt-aud"), "test-audience");
  assert.equal(calls[0].body.operationName, "SignInMutation");
  const status = sorareAuthenticationStatus();
  assert.equal(status.status, "ready");
  assert.equal(status.authenticated, true);
  assert.equal("token" in status, false);
});

test("re-signs in once after an authenticated 401", async () => {
  configure();
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) return signIn("jwt-one");
    if (call === 2) return json({ error: "unauthorized" }, 401);
    if (call === 3) return signIn("jwt-two");
    return json({ data: { value: 7 } });
  };

  const result = await sorareGraphql<{ value: number }>("query Test { value }", {});
  assert.deepEqual(result, { value: 7 });
  assert.equal(call, 4);
  assert.equal(sorareAuthenticationStatus().status, "ready");
});

test("stops when Sorare requires 2FA", async () => {
  configure();
  globalThis.fetch = async () =>
    json({
      data: {
        signIn: {
          currentUser: null,
          jwtToken: null,
          otpSessionChallenge: "challenge-present",
          tcuToken: null,
          errors: [],
        },
      },
    });

  await assert.rejects(
    () => sorareGraphql("query Test { value }", {}),
    /requires 2FA/,
  );
  const status = sorareAuthenticationStatus();
  assert.equal(status.status, "two_factor_required");
  assert.equal(status.authenticated, false);
});

test("keeps anonymous GraphQL available when Sorare JWT env is absent", async () => {
  config.sorareEmail = "";
  config.sorarePasswordHash = "";
  config.sorareJwtAud = "";
  config.sorareApiKey = "test-api-key";
  resetSorareClientForTests();
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("jwt-aud"), false);
    return json({ data: { value: 3 } });
  };

  const result = await sorareGraphql<{ value: number }>("query Test { value }", {});
  assert.deepEqual(result, { value: 3 });
  assert.equal(sorareAuthenticationStatus().status, "disabled");
});
