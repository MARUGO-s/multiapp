import assert from "node:assert/strict";
import { handler } from "../supabase/functions/marugo-qr/handler.ts";
import {
  QR_LOGO_CATALOG_HEADER,
  QR_LOGO_CATALOG_VALUE,
  QR_LOGOS,
} from "../supabase/functions/_shared/qr-logos.mjs";
import { createToken } from "../supabase/functions/_shared/session.mjs";

const owner = "00000000-0000-4000-8000-000000000061";
const actor = "00000000-0000-4000-8000-000000000064";
const foreignStore = "00000000-0000-4000-8000-000000000062";
const id = "00000000-0000-4000-8000-000000000063";
const token = "test.logo.jwt";
const initialLink = {
  id,
  owner_id: owner,
  code: "logoTest0001",
  title: "Poster",
  target_url: "https://example.com/",
  active: true,
  scan_count: 4,
  deleted_at: null,
  logo_id: null as string | null,
};
type Call = { name: string; args: any };

function request(
  route: string,
  method: string,
  payload?: unknown,
  auth = token,
) {
  return new Request(
    `https://logo-test.invalid/functions/v1/marugo-qr${route}`,
    {
      method,
      headers: {
        origin: "https://marugo-s.github.io",
        [QR_LOGO_CATALOG_HEADER]: QR_LOGO_CATALOG_VALUE,
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    },
  );
}

async function withBackend(
  run: (backend: {
    calls: Call[];
    link: typeof initialLink;
    failure: string;
    sharedToken: string;
  }) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const previous = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].map((name) =>
    [name, Deno.env.get(name)] as const
  );
  const backend = {
    calls: [] as Call[],
    link: { ...initialLink },
    failure: "",
    sharedToken: "",
  };
  Deno.env.set("SUPABASE_URL", "https://logo-test.invalid");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "disposable-test-key");
  globalThis.fetch = async (input, init: any) => {
    const url = new URL(String(input));
    assert.equal(
      url.hostname,
      "logo-test.invalid",
      "test cannot contact a real backend",
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
    assert.equal(authorization, "Bearer disposable-test-key");
    assert.ok(url.pathname.startsWith("/rest/v1/rpc/"));
    const name = url.pathname.split("/").at(-1)!;
    const args = JSON.parse(init.body);
    backend.calls.push({ name, args });
    if (name === "marugo_qr_accounts" || name === "marugo_qr_shared") {
      if (name === "marugo_qr_accounts") assert.equal(args.p_actor, actor);
      if (name === "marugo_qr_shared" && !backend.sharedToken) {
        return Response.json({ message: "INVALID_SESSION" }, { status: 400 });
      }
      if (args.p_store === foreignStore) {
        return Response.json({ message: "STORE_FORBIDDEN" }, { status: 400 });
      }
      return Response.json({ workspaceId: owner });
    }
    if (backend.failure) {
      return Response.json({ message: backend.failure }, { status: 400 });
    }
    if (name === "kotonoha_qr_file") {
      if (args.p_operation === "init") {
        return Response.json({ link: backend.link });
      }
      if (args.p_operation === "get") {
        return Response.json({ id, state: "ready", logo_id: "line-ios" });
      }
      if (args.p_operation === "complete") return Response.json(backend.link);
      throw new Error(`Unexpected file operation: ${args.p_operation}`);
    }
    assert.equal(name, "kotonoha_qr");
    assert.equal(args.p_owner, owner);
    if (args.p_operation === "logo") {
      backend.link.logo_id = args.p_payload.logoId;
    }
    if (args.p_operation === "create") {
      backend.link.logo_id = args.p_payload.logoId ?? null;
    }
    return Response.json(backend.link);
  };
  try {
    await run(backend);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("QR logo PATCH persists an explicit catalog ID in the verified store", async () => {
  await withBackend(async ({ calls, link }) => {
    const response = await handler(request(`/links/${id}/logo`, "PATCH", {
      logoId: "instagram-black",
      p_owner: foreignStore,
      ownerId: foreignStore,
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...initialLink,
      logo_id: "instagram-black",
    });
    assert.equal(link.logo_id, "instagram-black");
    assert.deepEqual(calls.at(-1), {
      name: "kotonoha_qr",
      args: {
        p_owner: owner,
        p_operation: "logo",
        p_id: id,
        p_payload: { logoId: "instagram-black" },
      },
    });
  });
});

Deno.test("QR logo PATCH requires its own explicit string/null property and rejects invalid values before persistence", async () => {
  await withBackend(async ({ calls }) => {
    for (const logoId of [null, "line-ios"]) {
      const response = await handler(
        request(`/links/${id}/logo`, "PATCH", { logoId }),
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).logo_id, logoId);
    }
    for (
      const payload of [
        {},
        { active: false },
        { logo_id: "line-ios" },
        ...[
          "",
          "LINE-IOS",
          "line-ios ",
          "../line-ios",
          "https://example.com/logo.png",
          "data:image/png;base64,a",
          1,
          false,
          [],
          {},
          "unknown",
        ].map((logoId) => ({ logoId })),
      ]
    ) {
      const before = calls.filter((call) => call.name === "kotonoha_qr").length;
      const response = await handler(
        request(`/links/${id}/logo`, "PATCH", payload),
      );
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.equal(
        calls.filter((call) => call.name === "kotonoha_qr").length,
        before,
        "invalid logo must never reach persistence",
      );
    }
  });
});

Deno.test("QR logo maps database INVALID_LOGO to a safe 400 response", async () => {
  await withBackend(async (backend) => {
    backend.failure = "INVALID_LOGO";
    const response = await handler(
      request(`/links/${id}/logo`, "PATCH", { logoId: "line-ios" }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "ロゴの指定が正しくありません。",
    });
  });
});

Deno.test("QR URL creation forwards a validated optional logo and preserves legacy null", async () => {
  await withBackend(async ({ calls }) => {
    const payload = {
      id,
      title: " Poster ",
      targetUrl: "https://example.com",
      ownerId: foreignStore,
    };
    for (const selection of [{ logoId: "line-ios" }, { logoId: null }, {}]) {
      const response = await handler(
        request("/links", "POST", { ...payload, ...selection }),
      );
      assert.equal(response.status, 201);
      const saved = await response.json();
      const expected = "logoId" in selection ? selection.logoId : null;
      assert.equal(saved.logo_id, expected);
      assert.equal(calls.at(-1)!.args.p_owner, owner);
      assert.equal(calls.at(-1)!.args.p_payload.logoId, expected);
      assert.equal(calls.at(-1)!.args.p_payload.title, "Poster");
      assert.equal(
        calls.at(-1)!.args.p_payload.targetUrl,
        "https://example.com/",
      );
      assert.match(calls.at(-1)!.args.p_payload.code, /^[A-Za-z0-9_-]{12}$/);
    }
    for (const logoId of ["unknown", "", 1, {}, [], false]) {
      const before = calls.filter((call) => call.name === "kotonoha_qr").length;
      assert.equal(
        (await handler(request("/links", "POST", { ...payload, logoId })))
          .status,
        400,
      );
      assert.equal(
        calls.filter((call) => call.name === "kotonoha_qr").length,
        before,
      );
    }
  });
});

Deno.test("QR file preparation validates and forwards the frozen optional logo without trusting body owner", async () => {
  await withBackend(async ({ calls }) => {
    const payload = {
      id,
      title: " Poster ",
      fileName: "menu.pdf",
      size: 100,
      publishConfirmed: true,
      p_owner: foreignStore,
    };
    for (
      const selection of [
        { logoId: "instagram-gradient" },
        { logoId: null },
        {},
      ]
    ) {
      const response = await handler(
        request("/uploads", "POST", { ...payload, ...selection }),
      );
      assert.equal(response.status, 200);
      assert.equal(calls.at(-1)!.name, "kotonoha_qr_file");
      assert.equal(calls.at(-1)!.args.p_owner, owner);
      assert.equal(calls.at(-1)!.args.p_operation, "init");
      assert.equal(
        calls.at(-1)!.args.p_payload.logoId,
        "logoId" in selection ? selection.logoId : null,
      );
      assert.equal(calls.at(-1)!.args.p_payload.title, "Poster");
    }
    for (const logoId of ["unknown", "", 1, {}, [], false]) {
      const before = calls.filter((call) =>
        call.name === "kotonoha_qr_file"
      ).length;
      assert.equal(
        (await handler(request("/uploads", "POST", { ...payload, logoId })))
          .status,
        400,
      );
      assert.equal(
        calls.filter((call) => call.name === "kotonoha_qr_file").length,
        before,
      );
    }
  });
});

Deno.test("QR logo PATCH accepts every catalog ID and existing shared-session authorization", async () => {
  await withBackend(async (backend) => {
    for (const { id: logoId } of QR_LOGOS) {
      const response = await handler(
        request(`/links/${id}/logo`, "PATCH", { logoId }),
      );
      assert.equal(response.status, 200, logoId);
      assert.equal((await response.json()).logo_id, logoId);
    }
    backend.sharedToken = createToken();
    const response = await handler(
      request(
        `/links/${id}/logo?storeId=${owner}`,
        "PATCH",
        { logoId: null },
        backend.sharedToken,
      ),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).logo_id, null);
    assert.equal(backend.calls.at(-2)!.name, "marugo_qr_shared");
    assert.equal(backend.calls.at(-2)!.args.p_store, owner);
    assert.equal(backend.calls.at(-1)!.args.p_owner, owner);
  });
});

Deno.test("QR logo management rejects unauthorized and forbidden stores before privileged persistence", async () => {
  await withBackend(async (backend) => {
    for (const auth of ["", "forged.jwt.signature", "malformed"]) {
      const before = backend.calls.filter((call) =>
        call.name === "kotonoha_qr"
      ).length;
      assert.equal(
        (await handler(
          request(`/links/${id}/logo`, "PATCH", { logoId: "line-ios" }, auth),
        )).status,
        401,
      );
      assert.equal(
        backend.calls.filter((call) => call.name === "kotonoha_qr").length,
        before,
      );
    }
    const response = await handler(
      request(`/links/${id}/logo?storeId=${foreignStore}`, "PATCH", {
        logoId: null,
        ownerId: owner,
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(
      backend.calls.some((call) => call.name === "kotonoha_qr"),
      false,
    );
    for (
      const [failure, status] of [["NOT_FOUND", 404], ["TRASHED", 409], [
        "REQUEST_CONFLICT",
        409,
      ]] as const
    ) {
      backend.failure = failure;
      const failed = await handler(
        request(`/links/${id}/logo`, "PATCH", {
          logoId: null,
          p_owner: foreignStore,
        }),
      );
      assert.equal(failed.status, status);
      assert.equal((await failed.json()).logo_id, undefined);
      assert.equal(backend.calls.at(-1)!.args.p_owner, owner);
    }
  });
});

Deno.test("QR logo endpoint retains body limits and leaves the existing active-only PATCH contract unchanged", async () => {
  await withBackend(async ({ calls }) => {
    for (
      const payload of [null, [], "line-ios", {
        __proto__: { logoId: "line-ios" },
      }]
    ) {
      assert.equal(
        (await handler(request(`/links/${id}/logo`, "PATCH", payload))).status,
        400,
      );
    }
    assert.equal(
      (await handler(
        request(`/links/${id}/logo`, "PATCH", {
          logoId: "line-ios",
          extra: "x".repeat(8200),
        }),
      )).status,
      413,
    );
    const malformed = request(`/links/${id}/logo`, "PATCH", {});
    assert.equal(
      (await handler(new Request(malformed, { body: "{" }))).status,
      400,
    );
    assert.equal(calls.some((call) => call.name === "kotonoha_qr"), false);
    assert.equal(
      (await handler(request(`/links/${id}`, "PATCH", { logoId: "line-ios" })))
        .status,
      400,
    );
    assert.equal(
      (await handler(
        request(`/links/${id}`, "PATCH", { active: false, logoId: "line-ios" }),
      )).status,
      200,
    );
    assert.deepEqual(calls.at(-1)!.args.p_payload, { active: false });
    assert.equal(calls.at(-1)!.args.p_operation, "active");
    const before = calls.filter((call) => call.name === "kotonoha_qr").length;
    for (const method of ["GET", "POST", "DELETE"]) {
      assert.equal(
        (await handler(
          request(
            `/links/${id}/logo`,
            method,
            method === "GET" ? undefined : { logoId: null },
          ),
        )).status,
        404,
      );
    }
    assert.equal(
      calls.filter((call) => call.name === "kotonoha_qr").length,
      before,
    );
  });
});

Deno.test("QR file completion ignores mutable body selection and returns the database's current logo", async () => {
  await withBackend(async (backend) => {
    backend.link.logo_id = "facebook-icons8-96";
    const response = await handler(
      request(`/uploads/${id}/complete`, "POST", {
        logoId: "untrusted",
        p_owner: foreignStore,
      }),
    );
    assert.equal(response.status, 201);
    assert.equal((await response.json()).logo_id, "facebook-icons8-96");
    assert.equal(backend.calls.at(-2)!.args.p_operation, "get");
    const completion = backend.calls.at(-1)!;
    assert.equal(completion.name, "kotonoha_qr_file");
    assert.equal(completion.args.p_operation, "complete");
    assert.equal(completion.args.p_owner, owner);
    assert.equal(Object.hasOwn(completion.args.p_payload, "logoId"), false);
    assert.match(
      completion.args.p_payload.targetUrl,
      /multiapp\/\?file=[A-Za-z0-9_-]{12}$/,
    );
  });
});
