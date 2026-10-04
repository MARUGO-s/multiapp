import assert from "node:assert/strict";
import { googleAuthRoute } from "../supabase/functions/_shared/kotonoha-google-auth.ts";
const uid = "00000000-0000-4000-8000-000000000101";
const target = "00000000-0000-4000-8000-000000000102";
Deno.test(
  "Google bridge: verified actor, bounded inputs, no metadata authority, approval required",
  async () => {
    const original = globalThis.fetch;
    Deno.env.set("SUPABASE_URL", "https://test.invalid");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only");
    let result: any = { member: null };
    const calls: any[] = [];
    const rpc = async (name: string, args: any) => {
      calls.push({ name, args });
      return { data: result, error: null };
    };
    globalThis.fetch = async (_url, options: any) => {
      const token = new Headers(options?.headers).get("authorization");
      if (token === "Bearer bad.expired.jwt")
        return Response.json({}, { status: 401 });
      return Response.json({
        id: uid,
        email_confirmed_at: "2026-10-04",
        user_metadata: { role: "admin", workspaceId: target },
      });
    };
    const request = (
      method = "GET",
      body?: unknown,
      token = "native.valid.jwt",
      proof?: string,
    ) =>
      new Request("https://test.invalid", {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(proof ? { "x-kotonoha": proof } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const denied = async (req: Request, path: string, status: number) => {
      await assert.rejects(
        () => googleAuthRoute(req, path, rpc),
        (e: any) => e.status === status,
      );
    };
    try {
      await denied(
        request("GET", undefined, "ktn_" + "a".repeat(64)),
        "/auth/google/context",
        401,
      );
      await denied(
        request("GET", undefined, "bad.expired.jwt"),
        "/auth/google/context",
        401,
      );
      assert.equal(calls.length, 0);
      await googleAuthRoute(request(), "/auth/google/context", rpc);
      assert.deepEqual(calls.at(-1), {
        name: "kotonoha_google_auth",
        args: {
          p_operation: "context",
          p_actor: uid,
          p_target: null,
          p_payload: {},
        },
      });
      await denied(request("POST"), "/auth/google/request", 403);
      await googleAuthRoute(
        request(
          "POST",
          { role: "admin", userId: target },
          undefined,
          "ktn_" + "a".repeat(64),
        ),
        "/auth/google/request",
        rpc,
      );
      assert.equal(calls.at(-1).args.p_actor, uid);
      assert.deepEqual(Object.keys(calls.at(-1).args.p_payload), [
        "legacyHash",
      ]);
      result = { error: "APPROVAL_REQUIRED" };
      await denied(request("POST"), "/auth/google/login", 403);
      result = { error: "ADMIN_REQUIRED" };
      await denied(
        request("POST", { action: "approve" }),
        `/auth/google/members/${target}`,
        403,
      );
      assert.equal(calls.at(-1).args.p_target, target);
      await denied(
        request("POST", { action: "approve", actor: target }),
        `/auth/google/members/${target}`,
        400,
      );
      await denied(
        request("POST", { action: "grant_admin" }),
        `/auth/google/members/${target}`,
        400,
      );
      await denied(
        request("POST", { action: "approve", padding: "a".repeat(1500) }),
        `/auth/google/members/${target}`,
        413,
      );
      await denied(
        request("POST", { action: "approve" }),
        "/auth/google/members/not-uuid",
        400,
      );
      result = { expiresAt: new Date(Date.now() + 3600000).toISOString() };
      const login = await googleAuthRoute(
        request("POST"),
        "/auth/google/login",
        rpc,
      );
      assert.match(login.token, /^ktn_[0-9a-f]{64}$/);
      assert.equal(login.googleUserId, uid);
      assert.match(calls.at(-1).args.p_payload.tokenHash, /^[0-9a-f]{64}$/);
      assert.notEqual(
        calls.at(-1).args.p_payload.tokenHash,
        login.token.slice(4),
      );
      await denied(request(), "/auth/google/request", 405);
    } finally {
      globalThis.fetch = original;
    }
  },
);
