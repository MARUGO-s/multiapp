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
  store_name: null as string | null,
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
    replyLink: boolean;
    rpcError: string | null;
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
    replyLink: false,
    rpcError: null as string | null,
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
    if (backend.rpcError) {
      return Response.json({ message: backend.rpcError }, { status: 400 });
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
          store_name: args.p_payload.storeName ?? null,
        };
      } else {
        assert.equal(args.p_operation, "logo");
        backend.link.logo_id = args.p_payload.logoId;
        if (Object.hasOwn(args.p_payload, "storeName")) {
          backend.link.store_name = args.p_payload.storeName;
        }
      }
      return Response.json(backend.link);
    }
    assert.equal(name, "kotonoha_qr_file");
    if (args.p_operation === "get") {
      return Response.json({
        id,
        state: "ready",
        initial_store_name: "Frozen original",
        logo_id: "store-marugo-d",
      });
    }
    if (args.p_operation === "complete") {
      assert.ok(
        !Object.hasOwn(args.p_payload, "storeName"),
        "complete must not send mutable client caption",
      );
      return Response.json(backend.link);
    }
    assert.equal(args.p_operation, "init");
    if (backend.replyLink) return Response.json({ link: backend.link });
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

Deno.test("store captions: init/completion retries return the current saved caption without client completion metadata", async () => {
  await withBackend(async (backend) => {
    backend.replyLink = true;
    backend.link = {
      ...baseLink,
      logo_id: "store-mitan",
      store_name: "Later saved caption",
    };
    for (const mode of backend.modes) {
      const response = await handler(
        request(`/uploads?storeId=${owner}`, "POST", {
          id,
          title: "File",
          fileName: "menu.pdf",
          size: 100,
          publishConfirmed: true,
          logoId: "store-marugo-d",
          storeName: "Frozen original",
        }, mode.auth),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { link: backend.link });
      const completion = await handler(
        request(`/uploads/${id}/complete?storeId=${owner}`, "POST", {
          storeName: "Forged",
          logoId: "instagram-black",
        }, mode.auth),
      );
      assert.equal(completion.status, 201);
      assert.deepEqual(await completion.json(), backend.link);
      assert.equal(backend.storagePaths.length, 0);
    }
  });
});

Deno.test("store captions: SQL validation errors stay 400, not ambiguous network failures", async () => {
  await withBackend(async (backend) => {
    backend.rpcError = "INVALID_STORE_NAME";
    for (const mode of backend.modes) {
      const response = await handler(
        request(`/links/${id}/logo?storeId=${owner}`, "PATCH", {
          logoId: "store-marugo-d",
          storeName: "valid",
        }, mode.auth),
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "店舗名は80文字以内の1行で入力してください。",
      });
    }
  });
});

Deno.test("store captions: every write forwards normalized caption, omission stays absent, native/shared scope unchanged", async () => {
  await withBackend(async (backend) => {
    for (const mode of backend.modes) {
      for (
        const [route, method, fields] of [
          ["/links", "POST", {
            id,
            title: "Caption QR",
            targetUrl: "https://example.com/caption",
          }],
          [`/links/${id}/logo`, "PATCH", {}],
          ["/uploads", "POST", {
            id,
            title: "Caption file",
            fileName: "menu.pdf",
            size: 100,
            publishConfirmed: true,
          }],
        ] as const
      ) {
        for (
          const caption of [{}, { storeName: null }, { storeName: "" }, {
            storeName: "　 店舗 😀  ",
          }, { storeName: "😀".repeat(80) }]
        ) {
          const before = backend.calls.length;
          const response = await handler(
            request(`${route}?storeId=${owner}`, method, {
              ...fields,
              logoId: "store-marugo-d",
              ...caption,
            }, mode.auth),
          );
          assert.ok(response.ok);
          const result = await response.json();
          if (route !== "/uploads") assert.deepEqual(result, backend.link);
          assertScope(backend.calls[before], mode);
          const payload = backend.calls[before + 1].args.p_payload;
          assert.equal(
            Object.hasOwn(payload, "storeName"),
            Object.hasOwn(caption, "storeName"),
          );
          if (Object.hasOwn(caption, "storeName")) {
            assert.equal(payload.storeName, caption.storeName?.trim() ?? null);
          }
          assert.equal(backend.calls[before + 1].args.p_id, id);
        }
      }
    }
  });
});

Deno.test("store captions: malformed/control/oversize and any non-null SNS/no-logo caption fail before privileged writes", async () => {
  await withBackend(async (backend) => {
    const cases = [
      ...[
        true,
        false,
        1,
        {},
        [],
        ["storeName"],
        "😀".repeat(81),
        "\ud800",
        "\udfff",
        ...Array.from({ length: 32 }, (_, i) => "x" + String.fromCodePoint(i)),
        ...Array.from(
          { length: 33 },
          (_, i) => "x" + String.fromCodePoint(127 + i),
        ),
        "x\u2028",
        "x\u2029",
      ].map((storeName) => ({ logoId: "store-marugo-d", storeName })),
      ...[null, "instagram-black"].flatMap((logoId) =>
        ["", "caption"].map((storeName) => ({ logoId, storeName }))
      ),
    ];
    for (const mode of backend.modes) {
      for (const caption of cases) {
        for (
          const [route, method, fields] of [
            ["/links", "POST", {
              id,
              title: "Caption",
              targetUrl: "https://example.com/",
            }],
            [`/links/${id}/logo`, "PATCH", {}],
            ["/uploads", "POST", {
              id,
              title: "Caption",
              fileName: "menu.pdf",
              size: 100,
              publishConfirmed: true,
            }],
          ] as const
        ) {
          const before = backend.calls.length;
          const response = await handler(
            request(`${route}?storeId=${owner}`, method, {
              ...fields,
              ...caption,
            }, mode.auth),
          );
          assert.equal(response.status, 400, JSON.stringify(caption));
          assert.deepEqual(await response.json(), {
            error: "店舗名は80文字以内の1行で入力してください。",
          });
          assert.equal(backend.calls.length, before + 1);
          assertScope(backend.calls[before], mode);
          assert.equal(backend.storagePaths.length, 0);
        }
      }
    }
  });
});
