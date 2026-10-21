import assert from "node:assert/strict";
import { handler } from "../supabase/functions/marugo-qr/handler.ts";
const id = "00000000-0000-4000-8000-000000000011";
const owner = "00000000-0000-4000-8000-000000000012";
const code = "fileTest0001";
const token = "test.valid.jwt";
Deno.env.set("SUPABASE_URL", "https://file-test.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-only");
const file = {
  id,
  owner_id: owner,
  path: `${owner}/${id}/file.pdf`,
  mime: "application/pdf",
  size: 9,
  title: "メニュー",
  file_name: "menu.pdf",
  state: "pending",
  link_id: null,
};
let uploaded = false;
let bad = false;
let state = "pending";
let storageDeleteFail = false;
const calls: any[] = [];
const originalFetch = globalThis.fetch;
const request = (path: string, method = "GET", payload?: any, auth = true) =>
  new Request(`https://file-test.invalid/functions/v1/marugo-qr${path}`, {
    method,
    headers: {
      origin: "https://marugo-s.github.io",
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
Deno.test(
  "QR files: authorization, safe upload verification, viewer, retries and guarded purge",
  async () => {
    globalThis.fetch = async (input, init: any) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user")
        return Response.json({
          id: owner,
          email_confirmed_at: "2026-10-03T00:00:00Z",
        });
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const args = JSON.parse(init.body);
        const name = url.pathname.split("/").at(-1);
        calls.push({ name, args });
        if (name === "marugo_qr_accounts")
          return Response.json({ workspaceId: owner });
        if (name === "kotonoha_qr_lifecycle")
          return Response.json({ id, purged: true });
        assert.equal(name, "kotonoha_qr_file");
        if (args.p_operation !== "public") assert.equal(args.p_owner, owner);
        if (args.p_operation === "complete") {
          state = "ready";
          return Response.json({ id, code });
        }
        if (args.p_operation === "begin_purge") {
          state = "deleting";
          return Response.json({ ...file, state });
        }
        if (args.p_operation === "removed") {
          state = "removed";
          return Response.json({ removed: true });
        }
        if (args.p_operation === "public" && state !== "ready")
          return Response.json({ message: "INACTIVE" }, { status: 400 });
        return Response.json({ ...file, state });
      }
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer test-only",
      );
      if (url.pathname.includes("/object/upload/sign/"))
        return Response.json({
          url: "/object/upload/sign/marugo-qr-files/test?token=safe-test",
        });
      if (url.pathname.includes("/object/sign/"))
        return Response.json({
          signedURL: "/object/sign/marugo-qr-files/test?token=safe-test",
        });
      if (init.method === "DELETE") {
        if (storageDeleteFail)
          return Response.json({ error: "failed" }, { status: 500 });
        return Response.json([]);
      }
      if (!uploaded)
        return Response.json({ error: "missing" }, { status: 404 });
      return new Response(bad ? "not a pdf" : "%PDF-1.7\n", {
        status: 206,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Range": "bytes 0-8/9",
        },
      });
    };
    try {
      for (const [path, method] of [
        ["/uploads", "POST"],
        [`/uploads/${id}/complete`, "POST"],
        [`/uploads/${id}`, "DELETE"],
      ])
        assert.equal(
          (await handler(request(path, method, { id }, false))).status,
          401,
        );
      assert.equal(calls.length, 0);
      const payload = {
        id,
        title: "メニュー",
        fileName: "menu.pdf",
        size: 9,
        publishConfirmed: true,
      };
      assert.equal(
        (
          await handler(
            request("/uploads", "POST", {
              ...payload,
              publishConfirmed: false,
            }),
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await handler(
            request("/uploads", "POST", { ...payload, fileName: "evil.svg" }),
          )
        ).status,
        400,
      );
      const html = await handler(
        request("/uploads", "POST", { ...payload, fileName: "page.html" }),
      );
      assert.equal(html.status, 200);
      assert.equal(
        calls.find((call) => call.args.p_payload?.fileName === "page.html")
          .args.p_payload.mime,
        "text/html",
      );
      const prepared = await handler(
        request("/uploads", "POST", { ...payload, p_owner: "different" }),
      );
      assert.equal(prepared.status, 200);
      assert.match((await prepared.json()).uploadUrl, /upload\/sign/);
      assert.equal(
        (await handler(request(`/uploads/${id}/complete`, "POST"))).status,
        409,
      );
      uploaded = true;
      bad = true;
      assert.equal(
        (await handler(request(`/uploads/${id}/complete`, "POST"))).status,
        400,
      );
      assert.equal(
        calls.some((c) => c.args.p_operation === "complete"),
        false,
      );
      bad = false;
      const retry = await handler(request("/uploads", "POST", payload));
      assert.equal((await retry.json()).uploaded, true);
      const completed = await handler(
        request(`/uploads/${id}/complete`, "POST"),
      );
      assert.equal(completed.status, 201);
      const completion = calls.find((c) => c.args.p_operation === "complete");
      assert.match(
        completion.args.p_payload.targetUrl,
        /multiapp\/\?file=[A-Za-z0-9_-]{12}$/,
      );
      const view = await handler(
        request("/files/fileTest0001", "GET", undefined, false),
      );
      assert.equal(view.status, 200);
      const data = await view.json();
      assert.equal(data.fileName, "menu.pdf");
      assert.equal(data.owner_id, undefined);
      assert.equal(data.path, undefined);
      assert.match(data.url, /object\/sign/);
      assert.equal(
        new URL(data.downloadUrl).searchParams.get("download"),
        "menu.pdf",
      );
      assert.equal(
        (
          await handler(
            request(`/links/${id}`, "DELETE", { confirmId: "wrong" }),
          )
        ).status,
        400,
      );
      storageDeleteFail = true;
      assert.equal(
        (await handler(request(`/links/${id}`, "DELETE", { confirmId: id })))
          .status,
        503,
      );
      assert.equal(
        calls.some((c) => c.name === "kotonoha_qr_lifecycle"),
        false,
      );
      assert.equal(
        (await handler(request("/files/fileTest0001", "GET", undefined, false)))
          .status,
        410,
      );
      storageDeleteFail = false;
      assert.equal(
        (await handler(request(`/links/${id}`, "DELETE", { confirmId: id })))
          .status,
        200,
      );
      assert.equal(state, "removed");
      assert.equal(calls.at(-1).name, "kotonoha_qr_lifecycle");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
