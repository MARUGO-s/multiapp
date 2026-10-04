import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as routing from "../src/qr-account-routing.mjs";
function harness(
  url,
  {
    recovery = false,
    failure = false,
    fetchResult = null,
    googleEnabled = false,
    portalEnabled = false,
  } = {},
) {
  const callbacks = new Set();
  let exchanges = 0;
  let clientOptions;
  const changes = [];
  const oauth = [];
  const redirects = [];
  const location = new URL(url);
  location.assign = (target) => redirects.push(target);
  const module = { exports: {} };
  const auth = {
    async signInWithOAuth(options) {
      oauth.push(options);
      return { data: { url: "https://accounts.google.com/test" }, error: null };
    },
    getSession: async () => ({
      data: { session: { access_token: "test.native.jwt" } },
      error: null,
    }),
    onAuthStateChange(fn) {
      callbacks.add(fn);
      return {
        data: {
          subscription: {
            unsubscribe() {
              callbacks.delete(fn);
            },
          },
        },
      };
    },
    async exchangeCodeForSession(code) {
      exchanges++;
      assert.equal(code, "one-use");
      if (failure)
        return { data: { session: null }, error: new Error("internal") };
      for (const fn of callbacks)
        fn(recovery ? "PASSWORD_RECOVERY" : "SIGNED_IN");
      return { data: { session: { user: { id: "test" } } }, error: null };
    },
  };
  const source = ts.transpileModule(
    readFileSync(
      new URL("../src/qr-account-client.ts", import.meta.url),
      "utf8",
    )
      .replaceAll("import.meta.env.BASE_URL", JSON.stringify("/multiapp/"))
      .replaceAll(
        "import.meta.env.VITE_QR_GOOGLE_AUTH_ENABLED",
        JSON.stringify(String(googleEnabled)),
      )
      .replaceAll(
        "import.meta.env.VITE_PORTAL_GOOGLE_AUTH_ENABLED",
        JSON.stringify(String(portalEnabled)),
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
    URL,
    Promise,
    Error,
    AbortSignal,
    fetch: async () => {
      if (fetchResult instanceof Error) throw fetchResult;
      return fetchResult;
    },
    location,
    history: {
      replaceState(...args) {
        changes.push(args[2]);
      },
    },
    require(name) {
      if (name === "@supabase/supabase-js")
        return {
          createClient(_url, _key, options) {
            clientOptions = options;
            return { auth };
          },
        };
      if (name === "./cloud")
        return {
          SUPABASE_URL: "https://test.invalid",
          SUPABASE_PUBLISHABLE_KEY: "public-only",
        };
      if (name === "./qr-account-routing.mjs") return routing;
      throw new Error(name);
    },
  });
  return {
    client: module.exports,
    changes,
    oauth,
    redirects,
    get exchanges() {
      return exchanges;
    },
    get options() {
      return clientOptions;
    },
  };
}
test("QR Auth uses isolated storage and explicit PKCE callbacks", async () => {
  const h = harness(
    "https://marugo-s.github.io/multiapp/?account=confirm&code=one-use",
  );
  assert.equal(h.options.auth.storageKey, "marugo-qr-auth");
  assert.equal(h.options.auth.flowType, "pkce");
  assert.equal(h.options.auth.detectSessionInUrl, false);
  const [a, b] = await Promise.all([
    h.client.finishAccountCallback(),
    h.client.finishAccountCallback(),
  ]);
  assert.equal(h.exchanges, 1);
  assert.equal(a.recovery, false);
  assert.equal(b.recovery, false);
  assert.deepEqual(h.changes, ["/multiapp/"]);
});
test("QR Google login is opt-in, uses isolated PKCE and has no additional scopes", async () => {
  const disabled = harness("https://marugo-s.github.io/multiapp/");
  await assert.rejects(disabled.client.signInQrWithGoogle(), /設定準備中/);
  assert.equal(disabled.oauth.length, 0);
  const enabled = harness("https://marugo-s.github.io/multiapp/", {
    googleEnabled: true,
  });
  await enabled.client.signInQrWithGoogle();
  assert.equal(enabled.oauth[0].provider, "google");
  assert.equal(
    enabled.oauth[0].options.redirectTo,
    "https://marugo-s.github.io/multiapp/?account=google",
  );
  assert.equal(enabled.oauth[0].options.skipBrowserRedirect, true);
  assert.equal(enabled.oauth[0].options.scopes, undefined);
  assert.deepEqual(enabled.redirects, ["https://accounts.google.com/test"]);
});
test("The common portal Google flag works without enabling the old QR-only flag", async () => {
  const h = harness("https://marugo-s.github.io/multiapp/", { portalEnabled: true });
  assert.equal(h.client.qrGoogleAuthEnabled, false);
  assert.equal(h.client.portalGoogleAuthEnabled, true);
  await h.client.signInQrWithGoogle();
  assert.equal(h.oauth[0].options.redirectTo, "https://marugo-s.github.io/multiapp/?account=google");
  assert.equal(h.options.auth.storageKey, "marugo-qr-auth");
});
test("QR Google callbacks exchange once and remove codes before opening QR", async () => {
  const h = harness(
    "https://marugo-s.github.io/multiapp/?account=google&code=one-use",
  );
  const [a, b] = await Promise.all([
    h.client.finishAccountCallback(),
    h.client.finishAccountCallback(),
  ]);
  assert.equal(h.exchanges, 1);
  assert.equal(a.recovery, false);
  assert.equal(b.recovery, false);
  assert.match(a.message, /会議録・QRの利用許可はそれぞれ/);
  assert.deepEqual(h.changes, ["/multiapp/"]);
  const denied = harness(
    "https://marugo-s.github.io/multiapp/?account=google#error=access_denied&error_description=private",
  );
  await assert.rejects(
    denied.client.finishAccountCallback(),
    /Googleログインが完了/,
  );
  assert.equal(denied.exchanges, 0);
  assert.deepEqual(denied.changes, ["/multiapp/"]);
});
test("Recovery mode is authorized by the SDK event, not an attacker-controlled query", async () => {
  const fake = harness(
    "https://marugo-s.github.io/multiapp/?account=recovery&code=one-use",
  );
  assert.equal((await fake.client.finishAccountCallback()).recovery, false);
  const real = harness(
    "https://marugo-s.github.io/multiapp/?account=recovery&code=one-use",
    { recovery: true },
  );
  assert.equal((await real.client.finishAccountCallback()).recovery, true);
  real.client.completeAccountRecovery();
  assert.equal((await real.client.finishAccountCallback()).recovery, false);
});
test("Expired/implicit links strip sensitive URLs and fail closed", async () => {
  const expired = harness(
    "https://marugo-s.github.io/multiapp/?account=recovery&code=one-use",
    { failure: true },
  );
  await assert.rejects(
    expired.client.finishAccountCallback(),
    /利用できません/,
  );
  assert.deepEqual(expired.changes, ["/multiapp/"]);
  const implicit = harness(
    "https://marugo-s.github.io/multiapp/#access_token=secret&refresh_token=private&type=recovery",
  );
  await assert.rejects(implicit.client.finishAccountCallback(), /無効/);
  assert.equal(implicit.exchanges, 0);
  assert.deepEqual(implicit.changes, ["/multiapp/"]);
});
test("Every QR path is bound to the immutable selected store", () => {
  const id = "00000000-0000-4000-8000-000000000103";
  assert.equal(
    routing.scopedQrPath("/links?page=2&storeId=forged", id),
    `/links?page=2&storeId=${id}`,
  );
  assert.equal(
    routing.scopedQrPath("/uploads/123/complete", id),
    `/uploads/123/complete?storeId=${id}`,
  );
  assert.throws(() => routing.scopedQrPath("https://evil.invalid/upload", id));
  assert.throws(() => routing.scopedQrPath("//evil.invalid", id));
  assert.throws(() => routing.scopedQrPath("/links", ""));
  assert.match(routing.passwordProblem("short", "short"), /12文字/);
  assert.match(routing.passwordProblem("longpassword123", "different"), /一致/);
  assert.equal(
    routing.passwordProblem("longpassword123", "longpassword123"),
    "",
  );
});
test("Account mutation transport failures are unconfirmed, not rejected; known denials stay rejected", async () => {
  const lost = harness("https://marugo-s.github.io/multiapp/", {
    fetchResult: new Error("offline"),
  });
  await assert.rejects(
    lost.client.accountApi("/members/test", { method: "POST" }),
    (e) =>
      e instanceof lost.client.AccountResultUnconfirmedError &&
      /処理済み/.test(e.message),
  );
  await assert.rejects(
    lost.client.accountApi("/members"),
    /情報を取得できません/,
  );
  const denied = harness("https://marugo-s.github.io/multiapp/", {
    fetchResult: {
      ok: false,
      status: 403,
      json: async () => ({ error: "全店舗管理者だけが操作できます。" }),
    },
  });
  await assert.rejects(
    denied.client.accountApi("/members/test", { method: "POST" }),
    (e) =>
      !(e instanceof denied.client.AccountResultUnconfirmedError) &&
      /全店舗管理者/.test(e.message),
  );
  const server = harness("https://marugo-s.github.io/multiapp/", {
    fetchResult: {
      ok: false,
      status: 503,
      json: async () => ({ error: "communication" }),
    },
  });
  await assert.rejects(
    server.client.accountApi("/members/test", { method: "POST" }),
    (e) => e instanceof server.client.AccountResultUnconfirmedError,
  );
});
