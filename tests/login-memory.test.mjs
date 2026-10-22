import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOGIN_MEMORY_KEY,
  forgetLogin,
  rememberLogin,
  rememberedLogin,
} from "../src/login-memory.mjs";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test("nothing is remembered by default", () => {
  assert.deepEqual(rememberedLogin(memoryStorage()), { remember: false, loginId: "" });
});

test("only the login ID is kept; the password never reaches app storage", () => {
  const storage = memoryStorage();
  rememberLogin(storage, "  marugo-user  ");
  assert.deepEqual(rememberedLogin(storage), { remember: true, loginId: "marugo-user" });
  const saved = [...storage.data.values()].join("");
  assert.doesNotMatch(saved, /password/i);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(LOGIN_MEMORY_KEY))).sort(), ["loginId", "v"]);
});

test("unchecking removes the remembered ID", () => {
  const storage = memoryStorage();
  rememberLogin(storage, "marugo-user");
  forgetLogin(storage);
  assert.equal(storage.getItem(LOGIN_MEMORY_KEY), null);
  assert.deepEqual(rememberedLogin(storage), { remember: false, loginId: "" });
});

test("broken or foreign values are ignored", () => {
  for (const value of ["not json", "{}", JSON.stringify({ v: 1, loginId: 5 }), JSON.stringify({ v: 2, loginId: "x" }), JSON.stringify({ v: 1, loginId: "a".repeat(201) })])
    assert.deepEqual(rememberedLogin(memoryStorage({ [LOGIN_MEMORY_KEY]: value })), { remember: false, loginId: "" }, value);
});

test("storage that throws (private mode, blocked) never breaks login", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.deepEqual(rememberedLogin(broken), { remember: false, loginId: "" });
  assert.doesNotThrow(() => rememberLogin(broken, "id"));
  assert.doesNotThrow(() => forgetLogin(broken));
  assert.deepEqual(rememberedLogin(null), { remember: false, loginId: "" });
});

test("an empty ID is not remembered", () => {
  const storage = memoryStorage();
  rememberLogin(storage, "   ");
  assert.equal(storage.getItem(LOGIN_MEMORY_KEY), null);
});

import { browserPassword, storeBrowserPassword } from "../src/login-memory.mjs";

test("the password goes to the browser password manager when it has one", async () => {
  const stored = [];
  class PasswordCredential { constructor(data) { Object.assign(this, data, { type: "password" }); } }
  const nav = { credentials: { store: async (c) => stored.push(c), get: async () => ({ type: "password", id: "marugo-user", password: "secret-value" }) } };
  assert.equal(await storeBrowserPassword(nav, { PasswordCredential }, "marugo-user", "secret-value"), true);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "marugo-user");
  assert.deepEqual(await browserPassword(nav, { PasswordCredential }), { loginId: "marugo-user", password: "secret-value" });
});

test("browsers without the API (Safari) or that refuse are handled quietly", async () => {
  assert.equal(await storeBrowserPassword({}, {}, "id", "pw"), false);
  assert.equal(await browserPassword({}, {}), null);
  class PasswordCredential {}
  const refusing = { credentials: { store: async () => { throw new Error("denied"); }, get: async () => { throw new Error("denied"); } } };
  assert.equal(await storeBrowserPassword(refusing, { PasswordCredential }, "id", "pw"), false);
  assert.equal(await browserPassword(refusing, { PasswordCredential }), null);
  const notPassword = { credentials: { get: async () => ({ type: "federated", id: "x" }) } };
  assert.equal(await browserPassword(notPassword, { PasswordCredential }), null);
});
