import assert from "node:assert/strict";
import { handler } from "../supabase/functions/marugo-qr/handler.ts";
import {
  QR_LOGO_CATALOG_HEADER,
  QR_LOGO_CATALOG_VALUE,
} from "../supabase/functions/_shared/qr-logos.mjs";
import {
  createToken,
  hashToken,
} from "../supabase/functions/_shared/session.mjs";

// Deliberately independent of QR_LOGOS: a forgotten catalog entry must fail.
const storeLogoIds = [
  "store-marugo-d",
  "store-marugo-es",
  "store-371bar",
  "store-blu-nero",
  "store-briccola",
  "store-cava",
  "store-claudia2",
  "store-donaiya",
  "store-erics",
  "store-koruri",
  "store-marugo-1",
  "store-marugo-2",
  "store-marugo-grande",
  "store-marugo-marunouchi",
  "store-marugo-otto",
  "store-marugo-shinbashi",
  "store-marugo-yotsuya",
  "store-mitan",
  "store-pelota",
  "store-sobaju",
  "store-violet",
  "store-x-c",
  "store-yakiniku",
] as const;
const owner = "00000000-0000-4000-8000-000000000091";
const actor = "00000000-0000-4000-8000-000000000092";
const foreignOwner = "00000000-0000-4000-8000-000000000093";
const id = "00000000-0000-4000-8000-000000000094";
const token = "test.store.jwt";
const baseLink = {
  id,
  owner_id: owner,
  code: "storeLogo001",
  title: "Existing store poster",
  target_url: "https://example.com/existing?keep=1",
  active: true,
  scan_count: 7,
  created_at: "2026-10-01T00:00:00Z",
  last_accessed_at: "2026-10-16T00:00:00Z",
  deleted_at: null,
  logo_id: null as string | null,
};
type Call = { name: string; args: any };
type Mode = { auth: string; scopeName: string; sharedHash?: string };

function request(
  route: string,
  method: string,
  payload: unknown,
  auth: string,
) {
  return new Request(
    `https://store-logo-test.invalid/functions/v1/marugo-qr${route}`,
    {
      method,
      headers: {
        origin: "https://marugo-s.github.io",
        [QR_LOGO_CATALOG_HEADER]: QR_LOGO_CATALOG_VALUE,
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(payload),
    },
  );
}

async function withBackend(
  run: (backend: {
    calls: Call[];
    storagePaths: string[];
    link: typeof baseLink;
    modes: Mode[];
  }) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const originalEnvGet = Deno.env.get;
  const sharedToken = createToken();
  const sharedHash = await hashToken(sharedToken);
  const backend = {
    calls: [] as Call[],
    storagePaths: [] as string[],
    link: { ...baseLink },
    modes: [
      { auth: token, scopeName: "marugo_qr_accounts" },
      { auth: sharedToken, scopeName: "marugo_qr_shared", sharedHash },
    ] as Mode[],
  };
  // Isolate config reads without inspecting or overwriting the process's values.
  // Existing suites leave fake env values behind, so absence is not an invariant.
  Deno.env.get = (name: string) => {
    if (name === "SUPABASE_URL") return "https://store-logo-test.invalid";
    if (name === "SUPABASE_SERVICE_ROLE_KEY") {
      return "disposable-store-logo-test-key";
    }
    throw new Error(`Unexpected environment read: ${name}`);
  };
  globalThis.fetch = async (input, init: any) => {
    const url = new URL(String(input));
    assert.equal(
      url.origin,
      "https://store-logo-test.invalid",
      "no real backend is reachable",
    );
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/auth/v1/user") {
      if (authorization !== `Bearer ${token}`) {
        return Response.json({}, { status: 401 });
      }
      return Response.json({
        id: actor,
        email_confirmed_at: "2026-10-01T00:00:00Z",
      });
    }
    assert.equal(authorization, "Bearer disposable-store-logo-test-key");
    if (url.pathname.startsWith("/storage/v1/")) {
      backend.storagePaths.push(url.pathname);
      assert.ok(
        url.pathname.endsWith(`/marugo-qr-files/${owner}/${id}/file.pdf`),
      );
      if (url.pathname.includes("/object/authenticated/")) {
        return Response.json({}, { status: 404 });
      }
      assert.ok(url.pathname.includes("/object/upload/sign/"));
      return Response.json({
        url:
          `/object/upload/sign/marugo-qr-files/${owner}/${id}/file.pdf?token=fixture`,
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
      if (args.p_store !== owner) {
        return Response.json({ message: "STORE_FORBIDDEN" }, { status: 400 });
      }
      return Response.json({ workspaceId: owner });
    }
    assert.equal(args.p_owner, owner);
    assert.equal(args.p_id, id);
    if (name === "kotonoha_qr") {
      if (args.p_operation === "create") {
        backend.link = {
          ...baseLink,
          title: args.p_payload.title,
          target_url: args.p_payload.targetUrl,
          logo_id: args.p_payload.logoId,
        };
      } else {
        assert.equal(args.p_operation, "logo");
        backend.link.logo_id = args.p_payload.logoId;
      }
      return Response.json(backend.link);
    }
    assert.equal(name, "kotonoha_qr_file");
    assert.equal(args.p_operation, "init");
    return Response.json({
      id,
      owner_id: owner,
      state: "pending",
      link_id: null,
      path: `${owner}/${id}/file.pdf`,
      title: args.p_payload.title,
      file_name: args.p_payload.fileName,
      mime: args.p_payload.mime,
      size: args.p_payload.size,
      logo_id: args.p_payload.logoId,
    });
  };
  try {
    await run(backend);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.env.get = originalEnvGet;
  }
}

function assertScope(call: Call, mode: Mode) {
  assert.equal(call.name, mode.scopeName);
  assert.deepEqual(call.args, {
    p_operation: "scope",
    ...(mode.sharedHash
      ? { p_token_hash: mode.sharedHash }
      : { p_actor: actor }),
    p_store: owner,
    p_target: null,
    p_payload: {},
  });
}

Deno.test(
  "store logos: all exact 23 URL creates preserve scope, request ID and non-logo inputs in native/shared sessions",
  async () => {
    assert.equal(storeLogoIds.length, 23);
    assert.equal(new Set(storeLogoIds).size, 23);
    await withBackend(async (backend) => {
      for (const mode of backend.modes) {
        for (const logoId of storeLogoIds) {
          const input = {
            id,
            title: " Store poster ",
            targetUrl: " https://example.com/catalog?keep=1 ",
            logoId,
            ownerId: foreignOwner,
            p_owner: foreignOwner,
            workspaceId: foreignOwner,
          };
          const original = structuredClone(input);
          const before = backend.calls.length;
          const response = await handler(
            request(`/links?storeId=${owner}`, "POST", input, mode.auth),
          );
          assert.equal(response.status, 201, `${mode.scopeName}: ${logoId}`);
          const saved = await response.json();
          assert.equal(saved.logo_id, logoId);
          assert.equal(saved.id, id);
          assert.equal(saved.owner_id, owner);
          assert.equal(backend.calls.length, before + 2);
          assertScope(backend.calls[before], mode);
          const call = backend.calls[before + 1];
          assert.match(call.args.p_payload.code, /^[A-Za-z0-9_-]{12}$/);
          assert.deepEqual(call, {
            name: "kotonoha_qr",
            args: {
              p_owner: owner,
              p_operation: "create",
              p_id: id,
              p_payload: {
                code: call.args.p_payload.code,
                title: "Store poster",
                targetUrl: "https://example.com/catalog?keep=1",
                logoId,
              },
            },
          });
          assert.deepEqual(input, original);
        }
      }
      assert.equal(backend.storagePaths.length, 0);
    });
  },
);

Deno.test(
  "store logos: all 23 shared/native PATCHes and removal forward only logoId and preserve every other response field",
  async () => {
    await withBackend(async (backend) => {
      for (const mode of backend.modes) {
        for (const logoId of [...storeLogoIds, null]) {
          const before = backend.calls.length;
          const response = await handler(
            request(
              `/links/${id}/logo?storeId=${owner}`,
              "PATCH",
              {
                logoId,
                id: foreignOwner,
                ownerId: foreignOwner,
                p_owner: foreignOwner,
                title: "forged title",
                targetUrl: "https://example.com/forged",
                active: false,
              },
              mode.auth,
            ),
          );
          assert.equal(response.status, 200, `${mode.scopeName}: ${logoId}`);
          assert.deepEqual(await response.json(), {
            ...baseLink,
            logo_id: logoId,
          });
          assert.equal(backend.calls.length, before + 2);
          assertScope(backend.calls[before], mode);
          assert.deepEqual(backend.calls[before + 1], {
            name: "kotonoha_qr",
            args: {
              p_owner: owner,
              p_operation: "logo",
              p_id: id,
              p_payload: { logoId },
            },
          });
        }
      }
      assert.equal(backend.storagePaths.length, 0);
    });
  },
);

Deno.test(
  "store logos: all 23 upload init payloads keep verified scope, stable ID, file specification and inputs",
  async () => {
    await withBackend(async (backend) => {
      for (const mode of backend.modes) {
        for (const logoId of storeLogoIds) {
          const input = {
            id,
            title: " Store menu ",
            fileName: "menu.pdf",
            size: 100,
            publishConfirmed: true,
            logoId,
            p_owner: foreignOwner,
            ownerId: foreignOwner,
          };
          const original = structuredClone(input);
          const before = backend.calls.length;
          const pathsBefore = backend.storagePaths.length;
          const response = await handler(
            request(`/uploads?storeId=${owner}`, "POST", input, mode.auth),
          );
          assert.equal(response.status, 200, `${mode.scopeName}: ${logoId}`);
          assert.deepEqual(await response.json(), {
            uploadUrl:
              `https://store-logo-test.invalid/storage/v1/object/upload/sign/marugo-qr-files/${owner}/${id}/file.pdf?token=fixture`,
            mime: "application/pdf",
          });
          assert.equal(backend.calls.length, before + 2);
          assertScope(backend.calls[before], mode);
          assert.deepEqual(backend.calls[before + 1], {
            name: "kotonoha_qr_file",
            args: {
              p_owner: owner,
              p_operation: "init",
              p_id: id,
              p_payload: {
                title: "Store menu",
                fileName: "menu.pdf",
                size: 100,
                mime: "application/pdf",
                extension: "pdf",
                logoId,
              },
            },
          });
          assert.equal(backend.storagePaths.length, pathsBefore + 2);
          assert.deepEqual(input, original);
        }
      }
    });
  },
);

Deno.test(
  "store logos: unknownLogo and malformed types are rejected before QR database RPCs or Storage in all three routes",
  async () => {
    await withBackend(async (backend) => {
      for (const mode of backend.modes) {
        for (
          const logoId of [
            "unknownLogo",
            "",
            1,
            [],
            {},
            false,
            "STORE-MARUGO-D",
            "store-marugo-d ",
          ]
        ) {
          for (
            const [route, method, fields] of [
              [
                "/links",
                "POST",
                {
                  id,
                  title: "Poster",
                  targetUrl: "https://example.com/",
                },
              ],
              [`/links/${id}/logo`, "PATCH", {}],
              [
                "/uploads",
                "POST",
                {
                  id,
                  title: "Menu",
                  fileName: "menu.pdf",
                  size: 100,
                  publishConfirmed: true,
                },
              ],
            ] as const
          ) {
            const before = backend.calls.length;
            const response = await handler(
              request(
                `${route}?storeId=${owner}`,
                method,
                { ...fields, logoId },
                mode.auth,
              ),
            );
            assert.equal(
              response.status,
              400,
              `${route}: ${JSON.stringify(logoId)}`,
            );
            assert.deepEqual(await response.json(), {
              error: "ロゴの指定が正しくありません。",
            });
            assert.equal(
              backend.calls.length,
              before + 1,
              "invalid logo reached a data RPC",
            );
            assertScope(backend.calls[before], mode);
            assert.deepEqual(backend.link, baseLink);
            assert.equal(backend.storagePaths.length, 0);
          }
        }
      }
    });
  },
);

Deno.test(
  "store logos: authentication and forbidden stores still block every write route before data RPCs",
  async () => {
    await withBackend(async (backend) => {
      const routes = [
        [
          "/links",
          "POST",
          {
            id,
            title: "Poster",
            targetUrl: "https://example.com/",
          },
        ],
        [`/links/${id}/logo`, "PATCH", {}],
        [
          "/uploads",
          "POST",
          {
            id,
            title: "Menu",
            fileName: "menu.pdf",
            size: 100,
            publishConfirmed: true,
          },
        ],
      ] as const;
      for (const [route, method, fields] of routes) {
        for (const auth of ["", "forged.jwt.signature", createToken()]) {
          const before = backend.calls.length;
          const response = await handler(
            request(
              `${route}?storeId=${owner}`,
              method,
              {
                ...fields,
                logoId: "store-marugo-d",
              },
              auth,
            ),
          );
          assert.equal(response.status, 401);
          assert.ok(
            backend.calls
              .slice(before)
              .every((call) => call.name === "marugo_qr_shared"),
          );
        }
        for (const mode of backend.modes) {
          const before = backend.calls.length;
          const response = await handler(
            request(
              `${route}?storeId=${foreignOwner}`,
              method,
              {
                ...fields,
                logoId: "store-marugo-d",
                p_owner: owner,
                ownerId: owner,
              },
              mode.auth,
            ),
          );
          assert.equal(response.status, 403);
          assert.equal(backend.calls.length, before + 1);
          assert.equal(backend.calls[before].name, mode.scopeName);
        }
      }
      assert.deepEqual(backend.link, baseLink);
      assert.equal(backend.storagePaths.length, 0);
    });
  },
);
