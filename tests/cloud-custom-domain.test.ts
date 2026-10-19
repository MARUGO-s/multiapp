import assert from "node:assert/strict";
import { hashToken } from "../supabase/functions/_shared/session.mjs";
import { QR_LOGO_CATALOG_HEADER } from "../supabase/functions/_shared/qr-logos.mjs";

// Run without --allow-net: only actual handlers and a fail-closed stub backend.
// Browser consumers: cloud.ts / portal-google-client.ts -> kotonoha-api;
// qr-account-client.ts -> marugo-accounts; qr-api.ts, PublicQrFile.tsx and
// public/marugo/redirect.js -> marugo-qr. Storage/Auth are separate services.
const backend = "https://custom-domain-test.invalid";
Deno.env.set("SUPABASE_URL", backend);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "custom-domain-test-only");
const { handler: portal } = await import(
  "../supabase/functions/kotonoha-api/handler.ts"
);
const { handler: accounts } = await import(
  "../supabase/functions/marugo-accounts/handler.ts"
);
const { handler: qr } = await import(
  "../supabase/functions/marugo-qr/handler.ts"
);
const customOrigins = [
  "https://marugo-waltz.com",
  "https://www.marugo-waltz.com",
];
const legacyOrigins = [
  "https://marugo-s.github.io",
  "http://localhost:5188",
  "http://127.0.0.1:5188",
];
const units = [
  {
    name: "kotonoha-api",
    handler: portal,
    path: "/auth/session",
    headers: "authorization,apikey,content-type,x-kotonoha",
    methods: ["GET", "POST"],
  },
  {
    name: "marugo-accounts",
    handler: accounts,
    path: "/context",
    headers: "authorization,apikey,content-type",
    methods: ["GET", "POST"],
  },
  {
    name: "marugo-qr",
    handler: qr,
    path: "/links",
    headers: `authorization,apikey,content-type,${QR_LOGO_CATALOG_HEADER}`,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  },
];
function request(
  unit: string,
  path: string,
  origin: string | null,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  return new Request(`${backend}/functions/v1/${unit}${path}`, {
    method,
    headers: {
      ...(origin === null ? {} : { origin }),
      "content-type": "application/json",
      apikey: "public-test-only",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "OPTIONS"
        ? {
          "access-control-request-method": "POST",
          "access-control-request-headers": units.find((unitInfo) =>
            unitInfo.name === unit
          )!.headers,
        }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cors(response: Response, origin: string) {
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("cache-control"), "no-store");
}
async function offline(
  run: (calls: { path: string; body: any }[]) => Promise<void>,
  reply?: (path: string, body: any) => Response,
) {
  const original = globalThis.fetch;
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(
      url.origin,
      backend,
      "Never contact production or other services",
    );
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path: url.pathname, body });
    assert.ok(reply, `Unexpected backend call: ${url.pathname}`);
    return reply(url.pathname, body);
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}
for (const unit of units) {
  for (const origin of customOrigins) {
    Deno.test(`${unit.name}: custom-domain preflight ${origin}`, async () => {
      await offline(async (calls) => {
        const response = await unit.handler(
          request(unit.name, unit.path, origin, "OPTIONS"),
        );
        assert.equal(response.status, 204);
        cors(response, origin);
        const allowedHeaders = response.headers.get(
          "access-control-allow-headers",
        )!.split(",").map((s) => s.trim());
        for (const header of unit.headers.split(",")) {
          assert.ok(allowedHeaders.includes(header), header);
        }
        for (const method of unit.methods) {
          assert.ok(
            response.headers.get("access-control-allow-methods")!.split(",")
              .includes(method),
          );
        }
        assert.equal(await response.text(), "");
        assert.equal(calls.length, 0);
      });
    });
    Deno.test(`${unit.name}: custom origin is not authentication ${origin}`, async () => {
      await offline(async (calls) => {
        const routes = unit.name === "marugo-qr"
          ? [["/links", "GET"], ["/uploads", "POST"]]
          : unit.name === "kotonoha-api"
          ? [["/auth/session", "GET"], ["/auth/logout", "POST"], [
            "/auth/google/context",
            "GET",
          ]]
          : [["/context", "GET"], ["/members", "GET"]];
        for (const [path, method] of routes) {
          const response = await unit.handler(
            request(unit.name, path, origin, method),
          );
          assert.equal(response.status, 401, path);
          cors(response, origin);
          assert.ok((await response.json()).error);
        }
        assert.equal(calls.length, 0);
      });
    });
  }
  Deno.test(`${unit.name}: existing origins and originless auth boundary are preserved`, async () => {
    await offline(async (calls) => {
      const origins = unit.name === "kotonoha-api"
        ? [...legacyOrigins, "http://127.0.0.1:5189", "http://127.0.0.1:4318"]
        : legacyOrigins;
      for (const origin of origins) {
        const response = await unit.handler(
          request(unit.name, unit.path, origin, "OPTIONS"),
        );
        assert.equal(response.status, 204);
        cors(response, origin);
      }
      const anonymous = await unit.handler(request(unit.name, unit.path, null));
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.headers.get("access-control-allow-origin"), null);
      assert.equal(calls.length, 0);
    });
  });
  Deno.test(`${unit.name}: HTTP, lookalikes and untrusted origins fail before backend I/O`, async () => {
    await offline(async (calls) => {
      for (
        const origin of [
          "http://marugo-waltz.com",
          "http://www.marugo-waltz.com",
          "https://marugo-waltz.com.evil.invalid",
          "https://evil.marugo-waltz.com",
          "https://www.marugo-waltz.com.evil.invalid",
          "https://marugo-waltz.com:444",
          "https://untrusted.invalid",
          "null",
        ]
      ) {
        for (const method of ["OPTIONS", "GET", "POST"]) {
          const response = await unit.handler(
            request(
              unit.name,
              unit.path,
              origin,
              method,
              undefined,
              "ktn_" + "a".repeat(64),
            ),
          );
          assert.equal(response.status, 403, `${origin} ${method}`);
          assert.equal(
            response.headers.get("access-control-allow-origin"),
            null,
          );
        }
      }
      assert.equal(calls.length, 0);
    });
  });
}
for (const origin of customOrigins) {
  Deno.test(`shared login, store scope, public scan and file contracts survive ${origin}`, async () => {
    const store = "00000000-0000-4000-8000-000000000101";
    const otherStore = "00000000-0000-4000-8000-000000000102";
    const code = "abcdefghijkl";
    let tokenHash = "";
    const expiresAt = "2099-01-01T00:00:00.000Z";
    await offline(async (calls) => {
      const invalid = await portal(
        request("kotonoha-api", "/auth/login", origin, "POST", {
          loginId: "fixture",
          password: "wrong-fixture",
        }),
      );
      assert.equal(invalid.status, 401);
      cors(invalid, origin);
      const login = await portal(
        request("kotonoha-api", "/auth/login", origin, "POST", {
          loginId: "fixture",
          password: "fixture-only",
        }),
      );
      assert.equal(login.status, 200);
      cors(login, origin);
      const session = await login.json();
      assert.match(session.token, /^ktn_[0-9a-f]{64}$/);
      assert.equal(await hashToken(session.token), tokenHash);
      assert.equal(session.expiresAt, expiresAt);
      const context = await accounts(
        request(
          "marugo-accounts",
          "/context",
          origin,
          "GET",
          undefined,
          session.token,
        ),
      );
      assert.equal(context.status, 200);
      cors(context, origin);
      assert.equal((await context.json()).stores[0].id, store);
      const links = await qr(
        request(
          "marugo-qr",
          `/links?storeId=${store}`,
          origin,
          "GET",
          undefined,
          session.token,
        ),
      );
      assert.equal(links.status, 200);
      cors(links, origin);
      assert.deepEqual(await links.json(), { links: [], total: 0 });
      assert.deepEqual(calls.at(-1)!.body, {
        p_owner: store,
        p_operation: "list",
        p_payload: { page: 0 },
      });
      for (
        const [scope, token, status] of [[otherStore, session.token, 403], [
          store,
          "ktn_" + "b".repeat(64),
          401,
        ]] as const
      ) {
        const before = calls.filter((c) =>
          c.path.endsWith("/kotonoha_qr")
        ).length;
        const denied = await qr(
          request(
            "marugo-qr",
            `/links?storeId=${scope}`,
            origin,
            "GET",
            undefined,
            token,
          ),
        );
        assert.equal(denied.status, status);
        cors(denied, origin);
        assert.equal(
          calls.filter((c) => c.path.endsWith("/kotonoha_qr")).length,
          before,
        );
      }
      const scan = await qr(
        request("marugo-qr", "/scan", origin, "POST", { code, eventId: store }),
      );
      assert.equal(scan.status, 200);
      cors(scan, origin);
      assert.deepEqual(await scan.json(), {
        targetUrl: "https://destination.invalid/",
      });
      const file = await qr(request("marugo-qr", `/files/${code}`, origin));
      assert.equal(file.status, 200);
      cors(file, origin);
      const fileData = await file.json();
      assert.equal(fileData.fileName, "fixture.pdf");
      assert.equal(new URL(fileData.url).origin, backend);
      assert.equal(
        new URL(fileData.downloadUrl).searchParams.get("download"),
        "fixture.pdf",
      );
    }, (path, body) => {
      if (path === "/rest/v1/rpc/kotonoha_auth") {
        assert.equal(body.p_operation, "login");
        if (body.p_payload.password !== "fixture-only") {
          return Response.json({ error: "INVALID_CREDENTIALS" });
        }
        assert.equal(body.p_payload.loginId, "fixture");
        tokenHash = body.p_payload.tokenHash;
        return Response.json({ expiresAt });
      }
      if (path === "/rest/v1/rpc/marugo_qr_shared") {
        if (body.p_token_hash !== tokenHash) {
          return Response.json({ message: "INVALID_SESSION" }, { status: 400 });
        }
        assert.equal(body.p_workspace, undefined);
        if (body.p_operation === "context") {
          return Response.json({
            stores: [{ id: store, name: "Fixture" }],
            accessMode: "shared",
          });
        }
        assert.equal(body.p_operation, "scope");
        if (body.p_store !== store) {
          return Response.json({ message: "STORE_FORBIDDEN" }, { status: 400 });
        }
        return Response.json({ workspaceId: store });
      }
      if (path === "/rest/v1/rpc/kotonoha_qr") {
        return Response.json({ links: [], total: 0 });
      }
      if (path === "/rest/v1/rpc/kotonoha_qr_scan_unique") {
        assert.equal(body.p_code, code);
        return Response.json({ targetUrl: "https://destination.invalid/" });
      }
      if (path === "/rest/v1/rpc/kotonoha_qr_file") {
        assert.deepEqual(body, { p_operation: "public", p_payload: { code } });
        return Response.json({
          path: "fixture/file.pdf",
          file_name: "fixture.pdf",
          title: "Fixture",
          mime: "application/pdf",
          size: 32,
        });
      }
      assert.equal(
        path,
        "/storage/v1/object/sign/marugo-qr-files/fixture/file.pdf",
      );
      assert.equal(body.expiresIn, 300);
      return Response.json({
        signedURL:
          "/object/sign/marugo-qr-files/fixture/file.pdf?token=fixture-only",
      });
    });
  });
}
