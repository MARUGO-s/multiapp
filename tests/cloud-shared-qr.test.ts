import assert from "node:assert/strict";
import { handler as accounts } from "../supabase/functions/marugo-accounts/handler.ts";
import { handler as qr } from "../supabase/functions/marugo-qr/handler.ts";
import { hashToken } from "../supabase/functions/_shared/session.mjs";

Deno.test(
  "Shared QR verifies the password session for context, each store and account changes",
  async () => {
    const original = globalThis.fetch;
    Deno.env.set("SUPABASE_URL", "https://shared-qr.invalid");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-test-only");
    const token = "ktn_" + "a".repeat(64);
    const tokenHash = await hashToken(token);
    const first = "00000000-0000-4000-8000-000000000101";
    const second = "00000000-0000-4000-8000-000000000102";
    let denied = "";
    let lastAdmin = false;
    const calls: { name: string; args: any }[] = [];
    const request = (route: string, method = "GET", body?: unknown) =>
      new Request(`https://shared-qr.invalid/functions/v1/${route}`, {
        method,
        headers: {
          origin: "https://marugo-s.github.io",
          authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      globalThis.fetch = async (input, init: any) => {
        const name = new URL(String(input)).pathname.split("/").at(-1)!;
        assert.equal(
          new Headers(init.headers).get("authorization"),
          "Bearer service-test-only",
        );
        const args = JSON.parse(init.body);
        calls.push({ name, args });
        if (name === "marugo_qr_shared") {
          assert.equal(args.p_token_hash, tokenHash);
          assert.equal(args.p_workspace, undefined);
          assert.ok(!init.body.includes(token));
          if (denied)
            return Response.json({ message: denied }, { status: 400 });
          if (args.p_operation === "scope")
            return Response.json({ workspaceId: args.p_store });
          if (lastAdmin)
            return Response.json({ message: "LAST_ADMIN" }, { status: 400 });
          return Response.json({
            accessMode: "shared",
            member: { role: "admin", status: "active" },
            stores: [],
          });
        }
        assert.equal(name, "kotonoha_qr");
        return Response.json({ links: [], total: 0 });
      };
      assert.equal(
        (await accounts(request("marugo-accounts/context"))).status,
        200,
      );
      for (const store of [first, second]) {
        assert.equal(
          (await qr(request(`marugo-qr/links?storeId=${store}`))).status,
          200,
        );
        assert.equal(calls.at(-2)!.args.p_operation, "scope");
        assert.equal(calls.at(-1)!.args.p_owner, store);
      }
      const beforeInvalid = calls.length;
      assert.equal(
        (await qr(request("marugo-qr/links?storeId=bad"))).status,
        400,
      );
      assert.equal(calls.length, beforeInvalid);
      assert.equal(
        (await accounts(request("marugo-accounts/members"))).status,
        200,
      );
      assert.equal(
        (
          await accounts(
            request(`marugo-accounts/members/${second}`, "POST", {
              action: "approve",
              actor: first,
              tokenHash: "forged",
            }),
          )
        ).status,
        200,
      );
      assert.deepEqual(calls.at(-1)!.args.p_payload, { action: "approve" });
      assert.equal(calls.at(-1)!.args.p_target, second);
      lastAdmin = true;
      assert.equal(
        (
          await accounts(
            request(`marugo-accounts/members/${second}`, "POST", {
              action: "suspend",
            }),
          )
        ).status,
        409,
      );
      lastAdmin = false;
      for (const [reason, status] of [
        ["INVALID_SESSION", 401],
        ["SHARED_QR_FORBIDDEN", 403],
      ] as const) {
        denied = reason;
        const dataCalls = calls.filter(
          (call) => call.name === "kotonoha_qr",
        ).length;
        assert.equal(
          (await accounts(request("marugo-accounts/context"))).status,
          status,
        );
        assert.equal(
          (await qr(request(`marugo-qr/links?storeId=${first}`))).status,
          status,
        );
        assert.equal(
          calls.filter((call) => call.name === "kotonoha_qr").length,
          dataCalls,
        );
      }
    } finally {
      globalThis.fetch = original;
    }
  },
);
