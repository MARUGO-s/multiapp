import assert from "node:assert/strict";
import {
  handler,
  CENTRAL,
} from "../supabase/functions/marugo-directory/handler.ts";
const admin = "00000000-0000-4000-8000-000000000001";
const normal = "00000000-0000-4000-8000-000000000002";
const remote = "https://ycsqfajidusuibqljjwr.supabase.co";
function token(overrides = {}) {
  const claims = {
    sub: admin,
    iss: CENTRAL + "/auth/v1",
    aud: "authenticated",
    role: "authenticated",
    amr: [{ method: "oauth" }],
    ...overrides,
  };
  return (
    "fixture." +
    btoa(JSON.stringify(claims))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_") +
    ".signature"
  );
}
function request(path = "users", bearer = token(), options: RequestInit = {}) {
  return new Request(CENTRAL + "/functions/v1/marugo-directory/" + path, {
    headers: {
      Authorization: "Bearer " + bearer,
      origin: "https://marugo-s.github.io",
    },
    ...options,
  });
}
Deno.test(
  "directory: verified OAuth identity, current admin registry and scoped approval boundaries",
  async () => {
    const original = globalThis.fetch;
    const calls: { url: string; args: any }[] = [];
    let revoked = false,
      expired = false,
      verified = true,
      hasGoogle = true,
      centralDown = false;
    let providerFailure = false,
      rateLimit = false;
    let canManage = true;
    let changeError = "";
    Deno.env.set("SUPABASE_URL", CENTRAL);
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-server-key");
    try {
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        const args = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url: url.href, args });
        if (url.pathname === "/auth/v1/user") {
          if (expired) return Response.json({}, { status: 401 });
          const claim = JSON.parse(
            atob(headers.get("authorization")!.split(".")[1]),
          );
          return Response.json({
            id: claim.sub,
            email_confirmed_at: verified ? "2026-10-05" : null,
            identities: hasGoogle ? [{ provider: "google" }] : [],
            user_metadata: { role: "admin" },
          });
        }
        if (url.pathname.endsWith("/authorize")) {
          if (centralDown) throw new Error("offline test");
          return Response.json(
            revoked
              ? { error: "forbidden" }
              : { authorized: true, actor: admin },
            { status: revoked ? 403 : 200 },
          );
        }
        assert.equal(headers.get("authorization"), "Bearer test-server-key");
        if (url.pathname.endsWith("marugo_directory_authorized")) {
          return Response.json(args.p_actor === admin && !revoked);
        }
        if (url.pathname.endsWith("marugo_directory_manage_authorized"))
          return Response.json(canManage && !revoked);
        if (url.pathname.endsWith("marugo_directory_change")) {
          if (changeError)
            return Response.json({ message: changeError }, { status: 400 });
          return Response.json({
            ok: true,
            key: args.p_key,
            requestId: args.p_request,
            status: "active",
          });
        }
        if (url.pathname.endsWith("marugo_directory_history"))
          return Response.json({ rows: [], nextOffset: null });
        assert.equal(url.pathname, "/rest/v1/rpc/marugo_directory_page");
        if (providerFailure)
          return Response.json(
            { message: "private backend error and secrets" },
            { status: 500 },
          );
        if (rateLimit)
          return Response.json({ message: "RATE_LIMIT" }, { status: 400 });
        return Response.json({
          rows: [],
          total: 0,
          nextOffset: null,
          asOf: "2026-10-05T00:00:00Z",
        });
      };
      for (const bad of ["", "ktn_" + "a".repeat(64), "broken"]) {
        const before = calls.length;
        assert.equal((await handler(request("users", bad))).status, 401);
        assert.equal(calls.length, before);
      }
      for (const claims of [
        { sub: normal },
        { role: "service_role" },
        { aud: "anon" },
        { iss: remote + "/auth/v1" },
        { amr: [{ method: "password" }] },
      ]) {
        const before = calls.filter((c) =>
          c.url.endsWith("marugo_directory_page"),
        ).length;
        assert.equal(
          (await handler(request("users", token(claims)))).status,
          403,
        );
        assert.equal(
          calls.filter((c) => c.url.endsWith("marugo_directory_page")).length,
          before,
        );
      }
      expired = true;
      assert.equal((await handler(request())).status, 401);
      expired = false;
      verified = false;
      assert.equal((await handler(request())).status, 403);
      verified = true;
      hasGoogle = false;
      assert.equal((await handler(request())).status, 403);
      hasGoogle = true;
      revoked = true;
      assert.equal((await handler(request())).status, 403);
      revoked = false;
      assert.equal((await handler(request("authorize"))).status, 200);
      const r = await handler(
        request(
          "users?app=qr&status=pending&q=alice&offset=100&p_actor=" + normal,
        ),
      );
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store, private");
      assert.deepEqual(calls.at(-1)?.args, {
        p_actor: admin,
        p_app: "qr",
        p_search: "alice",
        p_status: "pending",
        p_offset: 100,
      });
      for (const suffix of [
        "?offset=-1",
        "?offset=100000",
        "?offset=1.5",
        "?app=evil",
        "?status=evil",
        "?q=" + "x".repeat(161),
      ])
        assert.equal((await handler(request("users" + suffix))).status, 400);
      assert.equal(
        (
          await handler(
            request("users", token(), { method: "POST", body: "{}" }),
          )
        ).status,
        405,
      );
      assert.equal(
        (
          await handler(
            request("users", token(), {
              headers: {
                origin: "https://evil.invalid",
                Authorization: "Bearer " + token(),
              },
            }),
          )
        ).status,
        403,
      );
      assert.equal(
        (await handler(request("users", token(), { method: "OPTIONS" })))
          .status,
        204,
      );
      assert.equal((await handler(request("not-found"))).status, 404);
      providerFailure = true;
      const unavailable = await handler(request());
      assert.equal(unavailable.status, 503);
      assert.doesNotMatch(await unavailable.text(), /private backend|secrets/);
      providerFailure = false;
      rateLimit = true;
      assert.equal((await handler(request())).status, 429);
      rateLimit = false;
      const change = {
        requestId: normal,
        key: "qr:" + normal,
        action: "approve",
        version: "a".repeat(32),
        reason: "所属確認",
      };
      const post = (body: unknown) =>
        request("change", token(), {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token(),
            origin: "https://marugo-s.github.io",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      assert.equal((await handler(post(change))).status, 200);
      assert.equal(calls.at(-1)?.args.p_actor, admin);
      assert.equal(calls.at(-1)?.args.p_request, normal);
      const beforeWrites = calls.filter((c) =>
        c.url.endsWith("marugo_directory_change"),
      ).length;
      for (const invalid of [
        { ...change, actor: normal },
        { ...change, action: "grant_admin" },
        { ...change, key: "recipe:" + normal },
        { ...change, version: "old" },
        { ...change, reason: "" },
        { ...change, reason: "x".repeat(9000) },
        null,
      ]) {
        assert.ok([400, 413].includes((await handler(post(invalid))).status));
      }
      canManage = false;
      assert.equal((await handler(post(change))).status, 403);
      assert.equal(
        calls.filter((c) => c.url.endsWith("marugo_directory_change")).length,
        beforeWrites,
      );
      canManage = true;
      changeError = "STALE_STATE";
      assert.equal((await handler(post(change))).status, 409);
      changeError = "ADMIN_REQUIRED";
      assert.equal((await handler(post(change))).status, 403);
      changeError = "";
      assert.equal((await handler(request("change"))).status, 405);
      assert.equal((await handler(request("history"))).status, 200);
      assert.equal((await handler(request("history?offset=-1"))).status, 400);
      Deno.env.set("SUPABASE_URL", remote);
      assert.equal((await handler(post(change))).status, 404);
      assert.equal((await handler(request("history"))).status, 404);
      assert.equal((await handler(request())).status, 200);
      assert.equal(
        calls.at(-2)?.url,
        CENTRAL + "/functions/v1/marugo-directory/authorize",
      );
      assert.equal(
        calls.at(-1)?.url,
        remote + "/rest/v1/rpc/marugo_directory_page",
      );
      revoked = true;
      const count = calls.filter((c) =>
        c.url.endsWith("marugo_directory_page"),
      ).length;
      assert.equal((await handler(request())).status, 403);
      assert.equal(
        calls.filter((c) => c.url.endsWith("marugo_directory_page")).length,
        count,
      );
      revoked = false;
      centralDown = true;
      assert.equal((await handler(request())).status, 503);
      centralDown = false;
      assert.equal((await handler(request("authorize"))).status, 404);
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "");
      assert.equal((await handler(request())).status, 503);
    } finally {
      globalThis.fetch = original;
    }
  },
);
