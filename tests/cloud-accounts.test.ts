import assert from "node:assert/strict";
import { handler } from "../supabase/functions/marugo-accounts/handler.ts";
import { handler as qrHandler } from "../supabase/functions/marugo-qr/handler.ts";
const admin = "00000000-0000-4000-8000-000000000101";
const member = "00000000-0000-4000-8000-000000000102";
const store = "00000000-0000-4000-8000-000000000103";
const other = "00000000-0000-4000-8000-000000000104";
const calls: { name: string; args: any }[] = [];
const realFetch = globalThis.fetch;
Deno.env.set("SUPABASE_URL", "https://accounts-test.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-test-only");
function request(
  path: string,
  token = "admin.good.jwt",
  method = "GET",
  body?: unknown,
  origin = "https://marugo-s.github.io",
) {
  return new Request(`https://accounts-test.invalid/functions/v1/${path}`, {
    method,
    headers: { origin, Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
Deno.test(
  "QR accounts: verified identity, admin-only mutations, bounded inputs and store isolation",
  async () => {
    let pending = false;
    let revoked = false;
    try {
      globalThis.fetch = async (input, init: any) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/user") {
          const token = new Headers(init.headers).get("authorization");
          if (token === "Bearer expired.bad.jwt")
            return Response.json({ error: "bad" }, { status: 401 });
          if (token === "Bearer unverified.good.jwt")
            return Response.json({ id: member, email_confirmed_at: null });
          return Response.json({
            id: token === "Bearer admin.good.jwt" ? admin : member,
            email_confirmed_at: "2026-10-03T00:00:00Z",
          });
        }
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer service-test-only",
        );
        const name = url.pathname.split("/").at(-1)!;
        const args = JSON.parse(init.body);
        if (name === "marugo_qr_shared")
          return Response.json({ message: "INVALID_SESSION" }, { status: 400 });
        calls.push({ name, args });
        if (name === "marugo_qr_accounts") {
          const fail = (message: string) =>
            Response.json({ message }, { status: 400 });
          if (args.p_operation === "stores_public")
            return Response.json({ stores: [{ id: store, name: "test" }] });
          if (
            (args.p_operation === "members" ||
              args.p_operation === "update_member") &&
            (args.p_actor !== admin || revoked)
          )
            return fail("ADMIN_REQUIRED");
          if (args.p_operation === "scope") {
            if (pending) return fail("ACCOUNT_PENDING_OR_SUSPENDED");
            if (args.p_actor !== admin && args.p_store !== store)
              return fail("STORE_FORBIDDEN");
            return Response.json({ workspaceId: args.p_store || store });
          }
          return Response.json({
            member: {
              user_id: args.p_actor,
              status: "pending",
              role: "member",
            },
            stores: [],
          });
        }
        assert.equal(name, "kotonoha_qr");
        assert.equal(args.p_owner, store);
        return Response.json({ links: [], total: 0 });
      };
      assert.equal(
        (await handler(request("marugo-accounts/stores", ""))).status,
        200,
      );
      assert.equal(calls.at(-1)!.args.p_actor, null);
      for (const token of ["ktn_" + "a".repeat(64), "expired.bad.jwt", ""]) {
        const before = calls.length;
        assert.equal(
          (await handler(request("marugo-accounts/context", token))).status,
          401,
        );
        assert.equal(calls.length, before);
      }
      assert.equal(
        (
          await handler(
            request("marugo-accounts/context", "unverified.good.jwt"),
          )
        ).status,
        403,
      );
      assert.equal(
        (await handler(request("marugo-accounts/members", "member.good.jwt")))
          .status,
        403,
      );
      assert.equal(
        (
          await handler(
            request(
              `marugo-accounts/members/${member}`,
              "member.good.jwt",
              "POST",
              { action: "grant_admin", actor: admin },
            ),
          )
        ).status,
        403,
      );
      assert.equal(calls.at(-1)!.args.p_actor, member);
      assert.equal(
        (
          await handler(
            request("marugo-accounts/register", "member.good.jwt", "POST", {
              storeId: store,
              status: "active",
              role: "admin",
              userId: admin,
            }),
          )
        ).status,
        200,
      );
      assert.deepEqual(calls.at(-1)!.args, {
        p_operation: "register",
        p_actor: member,
        p_store: store,
        p_target: null,
        p_payload: {},
      });
      assert.equal(
        (
          await handler(
            request(
              `marugo-accounts/members/${member}`,
              "admin.good.jwt",
              "POST",
              { action: "grant_admin", actor: member },
            ),
          )
        ).status,
        200,
      );
      assert.equal(calls.at(-1)!.args.p_actor, admin);
      assert.equal(calls.at(-1)!.args.p_target, member);
      assert.deepEqual(calls.at(-1)!.args.p_payload, { action: "grant_admin" });
      revoked = true;
      assert.equal(
        (
          await handler(
            request(
              `marugo-accounts/members/${member}`,
              "admin.good.jwt",
              "POST",
              { action: "approve" },
            ),
          )
        ).status,
        403,
      );
      revoked = false;
      const before = calls.length;
      for (const body of [
        { action: "owner" },
        { action: "assign_store", storeId: "not-uuid" },
        [],
        "bad",
      ])
        assert.equal(
          (
            await handler(
              request(
                `marugo-accounts/members/${member}`,
                "admin.good.jwt",
                "POST",
                body,
              ),
            )
          ).status,
          400,
        );
      assert.equal(
        (
          await handler(
            request("marugo-accounts/register", "admin.good.jwt", "POST", {
              storeId: store,
              long: "x".repeat(5000),
            }),
          )
        ).status,
        413,
      );
      assert.equal(calls.length, before);
      assert.equal(
        (
          await handler(
            request(
              "marugo-accounts/context",
              "admin.good.jwt",
              "GET",
              undefined,
              "https://evil.invalid",
            ),
          )
        ).status,
        403,
      );
      assert.equal(
        (await handler(request("marugo-accounts/members?page=-1"))).status,
        400,
      );
      assert.equal(
        (await handler(request("marugo-accounts/members?storeId=bad"))).status,
        400,
      );
      assert.equal(
        (
          await qrHandler(
            request(`marugo-qr/links?storeId=${other}`, "member.good.jwt"),
          )
        ).status,
        403,
      );
      assert.equal(calls.at(-1)!.name, "marugo_qr_accounts");
      pending = true;
      assert.equal(
        (
          await qrHandler(
            request(`marugo-qr/links?storeId=${store}`, "member.good.jwt"),
          )
        ).status,
        403,
      );
      pending = false;
      assert.equal(
        (
          await qrHandler(
            request(`marugo-qr/links?storeId=${store}`, "member.good.jwt"),
          )
        ).status,
        200,
      );
      assert.equal(calls.at(-1)!.name, "kotonoha_qr");
      assert.equal(
        (
          await qrHandler(
            request(
              `marugo-qr/links?storeId=${store}`,
              "member.good.jwt",
              "POST",
              {
                id: member,
                title: "test",
                targetUrl: "https://example.com",
                ownerId: other,
              },
            ),
          )
        ).status,
        201,
      );
      assert.equal(calls.at(-1)!.args.p_owner, store);
      const noAuth = await handler(
        request("marugo-accounts/context", "expired.bad.jwt"),
      );
      assert.equal(noAuth.headers.get("cache-control"), "no-store");
      assert.equal(noAuth.headers.get("x-content-type-options"), "nosniff");
    } finally {
      globalThis.fetch = realFetch;
    }
  },
);
