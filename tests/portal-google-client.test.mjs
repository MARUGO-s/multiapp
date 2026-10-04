import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";
function harness({
  failure = null,
  transport = false,
  identity = "verified-uid",
} = {}) {
  const calls = [],
    saved = [],
    signedOut = [];
  let legacy = { token: "ktn_" + "a".repeat(64) };
  const module = { exports: {} };
  class UnknownResult extends Error {}
  const qrAuth = {
    auth: {
      getSession: async () => ({
        data: { session: { user: { id: identity } } },
      }),
      signOut: async (options) => {
        signedOut.push(options);
        return { error: null };
      },
    },
  };
  const source = ts.transpileModule(
    readFileSync(
      new URL("../src/portal-google-client.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    Error,
    AbortSignal,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (transport) throw new Error("transport");
      return Response.json(
        failure
          ? { error: "承認が必要です。" }
          : {
              token: "ktn_" + "b".repeat(64),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              googleUserId: "verified-uid",
            },
        { status: failure || 200 },
      );
    },
    require(name) {
      if (name === "./qr-account-client")
        return {
          qrAuth,
          qrAccessToken: async () => "verified.native.jwt",
          AccountResultUnconfirmedError: UnknownResult,
        };
      if (name === "./cloud")
        return {
          CLOUD_API: "https://test.invalid/kotonoha-api",
          SUPABASE_PUBLISHABLE_KEY: "public-only",
          getSession: () => legacy,
          saveSession: (record) => saved.push(record),
          signOut: async () => signedOut.push("legacy"),
        };
      throw Error(name);
    },
  });
  return {
    client: module.exports,
    calls,
    saved,
    signedOut,
    UnknownResult,
    setLegacy(value) {
      legacy = value;
    },
  };
}
test("common Google client never synthesizes a kotonoha authorization from identity", async () => {
  const h = harness();
  await h.client.openGoogleKotonoha();
  assert.equal(
    h.calls[0].url,
    "https://test.invalid/kotonoha-api/auth/google/login",
  );
  assert.equal(
    h.calls[0].options.headers.Authorization,
    "Bearer verified.native.jwt",
  );
  assert.equal(h.calls[0].options.headers["x-kotonoha"], undefined);
  assert.equal(h.saved[0].googleUserId, "verified-uid");
  const changed = harness({ identity: "another-uid" });
  await assert.rejects(
    () => changed.client.openGoogleKotonoha(),
    /アカウントが変わりました/,
  );
  assert.equal(changed.saved.length, 0);
  const pending = harness({ failure: 403 });
  await assert.rejects(() => pending.client.openGoogleKotonoha(), /承認/);
  assert.equal(pending.saved.length, 0);
});
test("legacy proof is only sent for explicit link request; unknown writes stay unconfirmed", async () => {
  const h = harness();
  await h.client.googleApi("/request", { method: "POST" });
  assert.equal(
    h.calls[0].options.headers["x-kotonoha"],
    "ktn_" + "a".repeat(64),
  );
  const unknown = harness({ transport: true });
  await assert.rejects(
    () => unknown.client.googleApi("/request", { method: "POST" }),
    unknown.UnknownResult,
  );
});
test("common logout revokes Google bridge and local native identity, not legacy password sessions", async () => {
  const h = harness();
  h.setLegacy({ googleUserId: "verified-uid" });
  await h.client.signOutGoogleAccount();
  assert.equal(h.signedOut[0], "legacy");
  assert.equal(h.signedOut[1].scope, "local");
  const legacy = harness();
  await legacy.client.signOutGoogleAccount();
  assert.equal(legacy.signedOut.length, 1);
  assert.equal(legacy.signedOut[0].scope, "local");
});
