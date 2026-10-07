import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { scopedQrPath } from "../src/qr-account-routing.mjs";
test("QR API binds all CRUD, analytics, trash and file requests to store and identity", async () => {
  const user = "00000000-0000-4000-8000-000000000101";
  const first = "00000000-0000-4000-8000-000000000102";
  const second = "00000000-0000-4000-8000-000000000103";
  let scope = { userId: user, storeId: first };
  let session = { user: { id: user }, access_token: "test.native.jwt" };
  let sharedCredentials = null;
  let status = 200;
  const calls = [];
  const module = { exports: {} };
  const source = ts.transpileModule(
    readFileSync(
      new URL("../src/qr-api.ts", import.meta.url),
      "utf8",
    ).replaceAll("import.meta.env.BASE_URL", JSON.stringify("/multiapp/")),
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
    Promise,
    AbortSignal,
    require(name) {
      if (name === "react")
        return {
          createContext: () => ({}),
          useContext: () => scope,
          useMemo: (fn) => fn(),
        };
      if (name === "./qr-account-client")
        return {
          qrCredentials: async () => {
            if (sharedCredentials) return sharedCredentials;
            if (!session) throw new Error("ログインが必要です。");
            return {
              kind: "account",
              identityKey: session.user.id,
              token: session.access_token,
            };
          },
        };
      if (name === "./cloud")
        return {
          SUPABASE_URL: "https://test.invalid",
          SUPABASE_PUBLISHABLE_KEY: "public-only",
          clearSession() {
            assert.fail("Must not clear kotonoha's shared session");
          },
        };
      if (name === "./qr-account-routing.mjs") return { scopedQrPath };
      if (name === "./qr-routing.mjs") return { buildTrackingUrl: () => "" };
      throw new Error(name);
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { status, ok: status === 200, json: async () => ({}) };
    },
  });
  const oldStore = module.exports.useQrApi();
  for (const path of [
    "/links?page=2",
    "/links/123/history?page=1",
    "/links/123/analytics?days=7",
    "/links/123/trash",
    "/links/123/restore",
    "/links/123",
    "/uploads",
    "/uploads/123/complete",
    "/uploads/123",
  ]) {
    await oldStore(path, { method: "POST" });
    const call = calls.at(-1);
    assert.equal(new URL(call.url).searchParams.get("storeId"), first);
    assert.equal(call.options.headers.Authorization, "Bearer test.native.jwt");
  }
  scope = { userId: user, storeId: second };
  const newStore = module.exports.useQrApi();
  await oldStore("/links");
  assert.equal(new URL(calls.at(-1).url).searchParams.get("storeId"), first);
  await newStore("/links");
  assert.equal(new URL(calls.at(-1).url).searchParams.get("storeId"), second);
  const before = calls.length;
  session = { ...session, user: { id: second } };
  await assert.rejects(oldStore("/links"), /所属店舗/);
  assert.equal(calls.length, before);
  session = null;
  await assert.rejects(newStore("/links"), /ログイン/);
  assert.equal(calls.length, before);
  session = { user: { id: user }, access_token: "expired.jwt.token" };
  status = 401;
  await assert.rejects(oldStore("/links"), /有効期限/);
  status = 200;
  sharedCredentials = {
    kind: "shared",
    identityKey: "test-shared-session",
    token: "ktn_test",
  };
  scope = {
    userId: user,
    storeId: second,
    credentialKey: sharedCredentials.identityKey,
  };
  const sharedStore = module.exports.useQrApi();
  await sharedStore("/links");
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer ktn_test");
  assert.equal(new URL(calls.at(-1).url).searchParams.get("storeId"), second);
  const sharedBefore = calls.length;
  await assert.rejects(oldStore("/links"), /ログイン情報/);
  sharedCredentials = {
    ...sharedCredentials,
    identityKey: "new-shared-session",
  };
  await assert.rejects(sharedStore("/links"), /ログイン情報/);
  sharedCredentials = null;
  await assert.rejects(sharedStore("/links"), /ログイン情報/);
  assert.equal(calls.length, sharedBefore);
});
