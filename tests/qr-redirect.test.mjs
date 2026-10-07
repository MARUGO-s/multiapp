import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../public/marugo/redirect.js", import.meta.url),
  "utf8",
).replace("export async function scan", "async function scan");
async function setup(
  hash,
  responses,
  search = "",
  referrer = "",
  options = {},
) {
  const calls = [];
  const destinations = [];
  const values = new Map();
  const storage = options.storage ?? {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let nextId = options.startId ?? 1;
  const elements = new Map(
    ["#status", "#retry", "#heading"].map((id) => [
      id,
      { textContent: "", hidden: true, addEventListener() {} },
    ]),
  );
  const context = vm.createContext({
    location: { hash, search, replace: (url) => destinations.push(url) },
    document: { referrer, querySelector: (id) => elements.get(id) },
    crypto: {
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    },
    localStorage: storage,
    Date: { now: () => options.now ?? 1_790_000_000_000 },
    URL,
    URLSearchParams,
    AbortSignal,
    fetch: async (_, args) => {
      calls.push(JSON.parse(args.body));
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return {
        ok: value.status === 200,
        status: value.status,
        json: async () => value.body,
      };
    },
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { context, calls, destinations, elements, storage };
}
test("Public QR: redirects only after recording and reuses event ID on a lost response", async () => {
  const state = await setup("#abcdefgh1234", [
    new Error("response lost"),
    {
      status: 200,
      body: { targetUrl: "https://example.com/landing" },
    },
  ]);
  assert.equal(state.destinations.length, 0);
  assert.equal(state.elements.get("#retry").hidden, false);
  await vm.runInContext("scan()", state.context);
  assert.deepEqual(state.calls[0], state.calls[1]);
  assert.deepEqual(state.destinations, ["https://example.com/landing"]);
});
test("Public QR: invalid code and stopped links never redirect", async () => {
  const invalid = await setup("#bad", []);
  assert.equal(invalid.calls.length, 0);
  const paused = await setup("#abcdefgh1234", [
    {
      status: 410,
      body: { error: "停止中" },
    },
  ]);
  assert.equal(paused.destinations.length, 0);
  assert.equal(paused.elements.get("#retry").hidden, true);
});
test("Public QR: non-http destination is rejected", async () => {
  const state = await setup("#abcdefgh1234", [
    {
      status: 200,
      body: { targetUrl: "javascript:alert(1)" },
    },
  ]);
  assert.equal(state.destinations.length, 0);
  assert.equal(state.elements.get("#retry").hidden, false);
});
test("QR attribution records a channel and domain only, excluding private path/query", async () => {
  const state = await setup(
    "#abcdefgh1234",
    [{ status: 200, body: { targetUrl: "https://example.com/" } }],
    "?s=b",
    "https://shop.example/private/customer?token=secret",
  );
  assert.equal(state.calls[0].source, "button");
  assert.equal(state.calls[0].referrerHost, "shop.example");
  assert.equal(JSON.stringify(state.calls).includes("secret"), false);
  const qr = await setup(
    "#abcdefgh1234",
    [{ status: 200, body: { targetUrl: "https://example.com/" } }],
    "?s=q",
  );
  assert.equal(qr.calls[0].source, "qr");
  assert.equal(qr.calls[0].referrerHost, null);
});
test("Old URLs and invalid source markers stay unknown", async () => {
  for (const query of ["", "?s=invalid"]) {
    const state = await setup(
      "#abcdefgh1234",
      [{ status: 200, body: { targetUrl: "https://example.com/" } }],
      query,
    );
    assert.equal(state.calls[0].source, "unknown");
  }
});
test("Visitor ID survives repeat navigation but event IDs stay navigation-specific", async () => {
  const ok = () => [
    { status: 200, body: { targetUrl: "https://example.com/" } },
  ];
  const first = await setup("#abcdefgh1234", ok());
  const second = await setup("#abcdefgh1234", ok(), "?s=b", "", {
    storage: first.storage,
    startId: 20,
  });
  assert.equal(first.calls[0].visitorId, second.calls[0].visitorId);
  assert.notEqual(first.calls[0].eventId, second.calls[0].eventId);
  assert.notEqual(first.calls[0].eventId, first.calls[0].visitorId);
  const otherQr = await setup("#otherqr12345", ok(), "", "", {
    storage: first.storage,
    startId: 40,
  });
  assert.notEqual(first.calls[0].visitorId, otherQr.calls[0].visitorId);
  const expired = await setup("#abcdefgh1234", ok(), "", "", {
    storage: first.storage,
    startId: 60,
    now: 1_790_000_000_000 + 181 * 86400000,
  });
  assert.notEqual(first.calls[0].visitorId, expired.calls[0].visitorId);
});
test("Blocked/read-only storage forwards normally without inventing unique IDs", async () => {
  for (const storage of [
    {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {},
    },
    {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("quota");
      },
    },
    {
      getItem() {
        return null;
      },
      setItem() {},
    },
    {
      getItem() {
        return "corrupt";
      },
      setItem() {},
    },
  ]) {
    const state = await setup(
      "#abcdefgh1234",
      [{ status: 200, body: { targetUrl: "https://example.com/" } }],
      "",
      "",
      { storage },
    );
    assert.equal(state.calls[0].visitorId, null);
    assert.equal(state.destinations.length, 1);
  }
});
