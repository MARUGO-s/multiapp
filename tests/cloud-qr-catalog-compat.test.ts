import assert from "node:assert/strict";
import { handler } from "../supabase/functions/marugo-qr/handler.ts";
import {
  QR_LOGO_CATALOG_HEADER,
  QR_LOGO_CATALOG_VALUE,
  QR_LOGOS,
} from "../supabase/functions/_shared/qr-logos.mjs";
import {
  createToken,
  hashToken,
} from "../supabase/functions/_shared/session.mjs";

const owner = "00000000-0000-4000-8000-000000000081";
const actor = "00000000-0000-4000-8000-000000000082";
const id = "00000000-0000-4000-8000-000000000083";
const token = "test.catalog.jwt";
const row = {
  id,
  owner_id: owner,
  code: "catalog00001",
  title: "Saved poster",
  target_url: "https://example.invalid/saved",
  active: true,
  scan_count: 12,
  deleted_at: null,
  logo_id: "store-marugo-d" as string | null,
};
type Call = { name: string; args: any };
type Backend = {
  calls: Call[];
  writes: Call[];
  storagePaths: string[];
  result: any;
  scopeFailure: string;
  dataFailure: string;
  sharedToken: string;
};

function request(route = "/links", init: RequestInit = {}) {
  return new Request(
    `https://catalog-test.invalid/functions/v1/marugo-qr${route}`,
    {
      ...init,
      headers: {
        origin: "https://marugo-s.github.io",
        authorization: `Bearer ${token}`,
        ...Object.fromEntries(new Headers(init.headers)),
      },
    },
  );
}

async function withBackend(run: (backend: Backend) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalEnvGet = Deno.env.get;
  const backend: Backend = {
    calls: [],
    writes: [],
    storagePaths: [],
    result: { links: [row], total: 1 },
    scopeFailure: "",
    dataFailure: "",
    sharedToken: createToken(),
  };
  const sharedHash = await hashToken(backend.sharedToken);
  Deno.env.get = (name: string) => {
    if (name === "SUPABASE_URL") return "https://catalog-test.invalid";
    if (name === "SUPABASE_SERVICE_ROLE_KEY") return "disposable-catalog-key";
    throw new Error(`Unexpected environment read: ${name}`);
  };
  globalThis.fetch = async (input, init: any) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://catalog-test.invalid", "no live backend");
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/auth/v1/user") {
      if (authorization !== `Bearer ${token}`) {
        return Response.json({}, { status: 401 });
      }
      return Response.json({ id: actor, email_confirmed_at: "2026-10-01" });
    }
    assert.equal(authorization, "Bearer disposable-catalog-key");
    if (url.pathname.startsWith("/storage/v1/")) {
      backend.storagePaths.push(url.pathname);
      assert.ok(url.pathname.startsWith("/storage/v1/object/sign/"));
      return Response.json({
        signedURL: "/object/sign/fixture?token=disposable",
      });
    }
    assert.ok(url.pathname.startsWith("/rest/v1/rpc/"));
    const name = url.pathname.split("/").at(-1)!;
    const args = JSON.parse(init.body);
    backend.calls.push({ name, args });
    if (name === "marugo_qr_accounts" || name === "marugo_qr_shared") {
      assert.equal(args.p_operation, "scope");
      if (name === "marugo_qr_accounts") assert.equal(args.p_actor, actor);
      else if (args.p_token_hash !== sharedHash) {
        return Response.json({ message: "INVALID_SESSION" }, { status: 400 });
      }
      const failure = backend.scopeFailure ||
        (args.p_store !== null && args.p_store !== owner
          ? "STORE_FORBIDDEN"
          : "");
      if (failure) {
        return Response.json(
          { message: failure, logo_id: row.logo_id },
          { status: 400 },
        );
      }
      return Response.json({ workspaceId: owner });
    }
    if (name === "kotonoha_qr_scan_unique") {
      return Response.json({
        targetUrl: "https://example.invalid/saved",
        logo_id: row.logo_id,
      });
    }
    if (name === "kotonoha_qr_file" && args.p_operation === "public") {
      return Response.json({
        path: `${owner}/${id}/file.pdf`,
        file_name: "menu.pdf",
        title: "Menu",
        size: 100,
        mime: "application/pdf",
        logo_id: row.logo_id,
      });
    }
    assert.equal(args.p_owner, owner);
    if (!["list", "trash_list", "get"].includes(args.p_operation)) {
      backend.writes.push({ name, args });
    }
    if (backend.dataFailure) {
      return Response.json(
        { message: backend.dataFailure, logo_id: row.logo_id },
        { status: 400 },
      );
    }
    if (name === "kotonoha_qr_file" && args.p_operation === "get") {
      return Response.json({ id, state: "ready", logo_id: row.logo_id });
    }
    return Response.json(backend.result);
  };
  try {
    await run(backend);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.get = originalEnvGet;
  }
}

Deno.test(
  "catalog compatibility: legacy no-header client never receives a stored store logo",
  async () => {
    await withBackend(async (backend) => {
      const saved = structuredClone(backend.result);
      const response = await handler(request());
      assert.equal(
        response.status,
        409,
        "legacy UI must not receive store ID as success",
      );
      const data = await response.json();
      assert.equal(data.code, "QR_CATALOG_UPDATE_REQUIRED");
      assert.match(data.error, /画面.*更新/);
      assert.equal(Object.hasOwn(data, "links"), false);
      assert.equal(Object.hasOwn(data, "logo_id"), false);
      assert.deepEqual(
        backend.result,
        saved,
        "never rewrite saved logo to null",
      );
      assert.deepEqual(
        backend.calls.map((call) => call.name),
        ["marugo_qr_accounts", "kotonoha_qr"],
      );
    });
  },
);

Deno.test(
  "catalog compatibility: current client receives all 38 saved IDs without transformation",
  async () => {
    await withBackend(async (backend) => {
      assert.equal(QR_LOGOS.length, 38);
      backend.result = {
        links: QR_LOGOS.map((logo) => ({ ...row, logo_id: logo.id })),
        total: 38,
      };
      const saved = structuredClone(backend.result);
      const response = await handler(
        request("/links", {
          headers: {
            "x-qr-logo-catalog": QR_LOGOS.map((logo) => logo.id).join(","),
          },
        }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), saved);
      assert.deepEqual(backend.result, saved);
    });
  },
);

Deno.test(
  "catalog compatibility: malformed/overlong declarations cannot unlock stored rows",
  async () => {
    await withBackend(async (backend) => {
      for (
        const header of [
          `${QR_LOGOS.map((logo) => logo.id).join(",")},*`,
          `store-marugo-d,${"x".repeat(4096)}`,
          "store-marugo-d,",
          "store-marugo-d,,line-ios",
          "store-marugo-d, LINE-IOS",
          "",
        ]
      ) {
        const response = await handler(
          request("/links", {
            headers: { "x-qr-logo-catalog": header },
          }),
        );
        assert.equal(response.status, 409, JSON.stringify(header));
        assert.equal(
          (await response.json()).code,
          "QR_CATALOG_UPDATE_REQUIRED",
        );
        assert.equal(backend.result.links[0].logo_id, "store-marugo-d");
      }
    });
  },
);

Deno.test(
  "catalog compatibility: CORS permits only the extra capability header, not new origins or methods",
  async () => {
    await withBackend(async (backend) => {
      const response = await handler(
        request("/links", {
          method: "OPTIONS",
          headers: {
            "access-control-request-headers":
              "authorization,apikey,content-type,x-qr-logo-catalog",
          },
        }),
      );
      assert.equal(response.status, 204);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        "https://marugo-s.github.io",
      );
      assert.equal(
        response.headers.get("access-control-allow-headers"),
        "authorization,apikey,content-type,x-qr-logo-catalog",
      );
      assert.equal(
        response.headers.get("access-control-allow-methods"),
        "GET,POST,PATCH,DELETE,OPTIONS",
      );
      assert.equal(response.headers.get("vary"), "Origin");
      const forbidden = await handler(
        request("/links", {
          method: "OPTIONS",
          headers: {
            origin: "https://forbidden.invalid",
            "x-qr-logo-catalog": "store-marugo-d",
          },
        }),
      );
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.headers.has("access-control-allow-origin"), false);
      assert.equal(backend.calls.length, 0);
    });
  },
);

Deno.test(
  "catalog compatibility: explicit legacyNoHeader accepts exactly the original SNS15/null in active/trash lists",
  async () => {
    const legacyIds = [
      "instagram-black",
      "instagram-gradient",
      "instagram-white",
      "line-android",
      "line-ios",
      "line-icons8-100",
      "line-icons8-50",
      "instagram-icons8-100",
      "instagram-icons8-50",
      "x-icons8-100",
      "x-icons8-50",
      "facebook-icons8-100",
      "facebook-icons8-48",
      "facebook-icons8-50",
      "facebook-icons8-96",
    ];
    await withBackend(async (backend) => {
      assert.equal(legacyIds.length, 15);
      backend.result = {
        links: [...legacyIds, null].map((logo_id) => ({ ...row, logo_id })),
        total: 16,
      };
      const saved = structuredClone(backend.result);
      for (const route of ["/links", "/links?view=trash"]) {
        const legacyNoHeader = request(route);
        assert.equal(legacyNoHeader.headers.has(QR_LOGO_CATALOG_HEADER), false);
        const response = await handler(legacyNoHeader);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), saved);
        assert.equal(
          backend.calls.at(-1)!.args.p_operation,
          route.includes("trash") ? "trash_list" : "list",
        );
      }
      assert.equal(backend.writes.length, 0);
      for (const logo_id of [...legacyIds, null]) {
        backend.result = { ...row, logo_id };
        const response = await handler(
          request("/links", {
            method: "POST",
            body: JSON.stringify({
              id,
              title: "Poster",
              targetUrl: row.target_url,
              logoId: logo_id,
            }),
          }),
        );
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), backend.result);
        assert.equal(backend.calls.at(-1)!.args.p_payload.logoId, logo_id);
      }
    });
  },
);

Deno.test(
  "catalog compatibility: every managed row/envelope is withheld for legacy clients and unchanged for capable ones",
  async () => {
    await withBackend(async (backend) => {
      const cases: {
        route: string;
        method: string;
        payload?: unknown;
        result: any;
        status: number;
      }[] = [
        {
          route: "/links",
          method: "GET",
          result: { links: [row], total: 1 },
          status: 200,
        },
        {
          route: "/links?view=trash",
          method: "GET",
          result: { links: [{ ...row, deleted_at: "2026-10-17" }], total: 1 },
          status: 200,
        },
        { route: "/links", method: "GET", result: [row], status: 200 },
        {
          route: `/links/${id}`,
          method: "PATCH",
          payload: { active: false },
          result: row,
          status: 200,
        },
        {
          route: `/links/${id}/trash`,
          method: "POST",
          result: row,
          status: 200,
        },
        {
          route: `/links/${id}/restore`,
          method: "POST",
          result: row,
          status: 200,
        },
        {
          route: "/links",
          method: "POST",
          payload: {
            id,
            title: " Retry poster ",
            targetUrl: "https://example.invalid/saved",
            logoId: null,
          },
          result: row,
          status: 201,
        },
        {
          route: "/uploads",
          method: "POST",
          payload: {
            id,
            title: "Menu",
            fileName: "menu.pdf",
            size: 100,
            publishConfirmed: true,
            logoId: null,
          },
          result: { link: row },
          status: 200,
        },
        {
          route: `/uploads/${id}/complete`,
          method: "POST",
          result: row,
          status: 201,
        },
      ];
      for (const item of cases) {
        backend.result = structuredClone(item.result);
        const snapshot = structuredClone(backend.result);
        for (const catalog of [null, QR_LOGO_CATALOG_VALUE]) {
          const response = await handler(
            request(item.route, {
              method: item.method,
              ...(item.payload === undefined
                ? {}
                : { body: JSON.stringify(item.payload) }),
              headers: catalog === null
                ? {}
                : { [QR_LOGO_CATALOG_HEADER]: catalog },
            }),
          );
          assert.equal(
            response.status,
            catalog === null ? 409 : item.status,
            `${item.method} ${item.route}`,
          );
          const data = await response.json();
          if (catalog === null) {
            assert.equal(data.code, "QR_CATALOG_UPDATE_REQUIRED");
            assert.deepEqual(Object.keys(data).sort(), ["code", "error"]);
            assert.match(data.error, /保存済みの可能性/);
            assert.doesNotMatch(data.error, /未登録|保存されていません/);
          } else {
            assert.deepEqual(data, snapshot);
          }
          assert.deepEqual(backend.result, snapshot);
        }
      }
      const creates = backend.writes.filter(
        (call) => call.args.p_operation === "create",
      );
      assert.equal(creates.length, 2);
      assert.ok(creates.every((call) => call.args.p_id === id));
      assert.equal(backend.storagePaths.length, 0);
    });
  },
);

Deno.test(
  "catalog compatibility: declared future IDs are response metadata, never a write allowlist",
  async () => {
    await withBackend(async (backend) => {
      const future = "future-logo-v2";
      backend.result = { links: [{ ...row, logo_id: future }], total: 1 };
      for (const catalog of [null, QR_LOGO_CATALOG_VALUE]) {
        const response = await handler(
          request("/links", {
            headers: catalog === null
              ? {}
              : { [QR_LOGO_CATALOG_HEADER]: catalog },
          }),
        );
        assert.equal(response.status, 409);
        assert.equal(
          (await response.json()).code,
          "QR_CATALOG_UPDATE_REQUIRED",
        );
      }
      const header = `${QR_LOGO_CATALOG_VALUE},${future}`;
      const response = await handler(
        request("/links", { headers: { [QR_LOGO_CATALOG_HEADER]: header } }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), backend.result);
      const before = backend.calls.length;
      const forbiddenWrite = await handler(
        request(`/links/${id}/logo`, {
          method: "PATCH",
          body: JSON.stringify({ logoId: future }),
          headers: { [QR_LOGO_CATALOG_HEADER]: header },
        }),
      );
      assert.equal(forbiddenWrite.status, 400);
      assert.deepEqual(await forbiddenWrite.json(), {
        error: "ロゴの指定が正しくありません。",
      });
      assert.equal(
        backend.calls.length,
        before + 1,
        "only authorization may run",
      );
      assert.equal(backend.writes.length, 0);
    });
  },
);

Deno.test(
  "catalog compatibility: native/shared capability claims never bypass authentication, role or store rejection",
  async () => {
    await withBackend(async (backend) => {
      for (const catalog of ["store-marugo-d", "*", "x".repeat(4097)]) {
        for (
          const authorization of [
            "",
            "Bearer forged.jwt.signature",
            `Bearer ${createToken()}`,
          ]
        ) {
          const before = backend.calls.length;
          const response = await handler(
            request("/links", {
              headers: { authorization, [QR_LOGO_CATALOG_HEADER]: catalog },
            }),
          );
          assert.equal(response.status, 401);
          assert.equal((await response.json()).code, undefined);
          assert.ok(
            backend.calls
              .slice(before)
              .every((call) => call.name === "marugo_qr_shared"),
          );
        }
        for (const auth of [token, backend.sharedToken]) {
          for (
            const failure of [
              "ACCOUNT_PENDING_OR_SUSPENDED",
              "ADMIN_REQUIRED",
              "STORE_FORBIDDEN",
              "SHARED_QR_FORBIDDEN",
            ]
          ) {
            backend.scopeFailure = failure;
            const before = backend.calls.length;
            const response = await handler(
              request(`/links?storeId=${owner}`, {
                headers: {
                  authorization: `Bearer ${auth}`,
                  [QR_LOGO_CATALOG_HEADER]: catalog,
                },
              }),
            );
            assert.equal(response.status, 403, failure);
            const data = await response.json();
            assert.equal(data.code, undefined);
            assert.equal(data.logo_id, undefined);
            assert.equal(backend.calls.length, before + 1);
            assert.equal(
              backend.calls.at(-1)!.name,
              auth === token ? "marugo_qr_accounts" : "marugo_qr_shared",
            );
          }
        }
      }
      backend.scopeFailure = "";
      for (const auth of [token, backend.sharedToken]) {
        const response = await handler(
          request("/links?storeId=00000000-0000-4000-8000-000000000089", {
            headers: {
              authorization: `Bearer ${auth}`,
              [QR_LOGO_CATALOG_HEADER]: QR_LOGO_CATALOG_VALUE,
            },
          }),
        );
        assert.equal(response.status, 403);
        const permitted = await handler(
          request(`/links?storeId=${owner}`, {
            headers: {
              authorization: `Bearer ${auth}`,
              [QR_LOGO_CATALOG_HEADER]: QR_LOGO_CATALOG_VALUE,
            },
          }),
        );
        assert.equal(permitted.status, 200);
        assert.deepEqual(await permitted.json(), backend.result);
      }
      assert.equal(backend.writes.length, 0);
    });
  },
);

Deno.test(
  "catalog compatibility: existing error responses retain status/message, never becoming catalog conflicts",
  async () => {
    await withBackend(async (backend) => {
      for (
        const [failure, status, error] of [
          ["INVALID_LOGO", 400, "ロゴの指定が正しくありません。"],
          ["NOT_FOUND", 404, "このQRコードは見つかりません。"],
          [
            "TRASHED",
            409,
            "このQRコードはゴミ箱にあります。復元してから操作してください。",
          ],
          [
            "REQUEST_CONFLICT",
            409,
            "入力内容が変わりました。もう一度作成してください。",
          ],
        ] as const
      ) {
        backend.dataFailure = failure;
        for (
          const headers of [{}, { [QR_LOGO_CATALOG_HEADER]: "*" }] as Record<
            string,
            string
          >[]
        ) {
          const response = await handler(request("/links", { headers }));
          assert.equal(response.status, status);
          assert.deepEqual(await response.json(), { error });
        }
      }
    });
  },
);

Deno.test(
  "catalog compatibility: public scan/files stay anonymous and independent of the management capability gate",
  async () => {
    await withBackend(async (backend) => {
      for (
        const headers of [
          { authorization: "" },
          { authorization: "", [QR_LOGO_CATALOG_HEADER]: "*" },
          { authorization: "", [QR_LOGO_CATALOG_HEADER]: "x".repeat(4097) },
        ] as Record<string, string>[]
      ) {
        const scanned = await handler(
          request("/scan", {
            method: "POST",
            headers,
            body: JSON.stringify({ code: row.code, eventId: id }),
          }),
        );
        assert.equal(scanned.status, 200);
        assert.deepEqual(await scanned.json(), {
          targetUrl: "https://example.invalid/saved",
        });
        const file = await handler(request(`/files/${row.code}`, { headers }));
        assert.equal(file.status, 200);
        const data = await file.json();
        assert.equal(data.fileName, "menu.pdf");
        assert.equal(new URL(data.url).hostname, "catalog-test.invalid");
        assert.equal(data.code, undefined);
        assert.equal(data.logo_id, undefined);
      }
      assert.ok(
        backend.calls.every(
          (call) =>
            call.name === "kotonoha_qr_scan_unique" ||
            (call.name === "kotonoha_qr_file" &&
              call.args.p_operation === "public"),
        ),
      );
      assert.equal(backend.storagePaths.length, 6);
      assert.equal(backend.writes.length, 0);
    });
  },
);
