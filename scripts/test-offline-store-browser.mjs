import {
  offlineBrowserFixture,
  localOnlyPage,
} from "./offline-browser-fixture.mjs";
import { chromium } from "playwright";
import assert from "node:assert/strict";
const server = await offlineBrowserFixture(5195, "SYNTHETIC offline fixture");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await localOnlyPage(browser);
  await page.goto("http://127.0.0.1:5195/offline-fixture");
  const result = await page.evaluate(async () => {
    const m = await import("/src/offline-store.ts");
    const draft = {
      id: "draft-A",
      scope: { ownerId: "owner-A", actorId: "actor-A" },
      mode: "file",
      metadata: {
        title: "SYNTHETIC 日本語",
        date: "2026-10-28",
        participants: "fixture",
        template: "standard",
      },
      transcript: "",
      files: [
        new File(["SYNTHETIC AUDIO"], "fixture.wav", { type: "audio/wav" }),
      ],
      attachments: [new File(["SYNTHETIC DOC"], "fixture.txt")],
      sessionIds: [],
      updatedAt: 1,
    };
    await m.saveDraft(draft);
    await m.saveDraft({ ...draft, id: "draft-B" });
    const loaded = await m.getDraft("draft-A");
    await m.saveDraft({ ...draft, id: "closed-draft" });
    await m.deleteDraft("closed-draft");
    let resurrectionRejected = false;
    try {
      await m.saveDraft({ ...draft, id: "closed-draft" });
    } catch {
      resurrectionRejected = true;
    }
    const noResurrection =
      resurrectionRejected && !(await m.getDraft("closed-draft"));
    const attempt = {
      input: { uploadId: crypto.randomUUID() },
      parts: [],
      attachments: [],
      identity: {
        uploadId: "first",
        ownerId: "owner-A",
        planDigest: "a".repeat(64),
      },
    };
    await m.freezeDraft(
      "draft-A",
      attempt,
      (await m.getDraft("draft-A")).revision || 0,
    );
    const again = await m.freezeDraft(
      "draft-A",
      {
        ...attempt,
        identity: { ...attempt.identity, uploadId: "second" },
      },
      (await m.getDraft("draft-A")).revision || 0,
    );
    await m.saveDraft({
      ...draft,
      id: "text-switch",
      mode: "text",
      transcript: "SYNTHETIC text",
      sessionIds: ["unused-original"],
      sourceSessions: ["unused-original"],
    });
    await m.freezeDraft(
      "text-switch",
      attempt,
      (await m.getDraft("text-switch")).revision || 0,
    );
    const leftover = (await m.listDrafts()).find(
      (d) => d.id !== "text-switch" && d.sessionIds.includes("unused-original"),
    );
    let immutable = false;
    try {
      await m.saveDraft({
        ...draft,
        metadata: { ...draft.metadata, title: "changed" },
      });
    } catch {
      immutable = true;
    }
    const native = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = native.apply(this, args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    };
    let aborted = false;
    try {
      await m.saveDraft({ ...draft, id: "abort" });
    } catch {
      aborted = true;
    } finally {
      IDBDatabase.prototype.transaction = native;
    }
    return {
      noResurrection,
      leftover: !!leftover && !leftover.attempt && leftover.mode === "file",
      title: loaded.metadata.title,
      audio: await loaded.files[0].text(),
      attachment: await loaded.attachments[0].text(),
      stable: again.attempt.identity.uploadId,
      immutable,
      aborted,
      other: !!(await m.getDraft("draft-B")),
    };
  });
  assert.equal(result.title, "SYNTHETIC 日本語");
  assert.equal(
    result.noResurrection,
    true,
    "stale autosave in another tab cannot resurrect an accepted/deleted draft",
  );
  assert.equal(result.audio, "SYNTHETIC AUDIO");
  assert.equal(result.attachment, "SYNTHETIC DOC");
  assert.equal(result.stable, "first");
  assert.equal(result.immutable, true);
  assert.equal(result.aborted, true);
  assert.equal(result.other, true);
  console.log(
    "PASS real IndexedDB draft files/metadata, immutable CAS freeze, abort surfaced",
    result,
  );
  assert.equal(
    result.leftover,
    true,
    "text submission must retain unsubmitted audio in a separate editable draft",
  );
  await page.reload();
  const restored = await page.evaluate(async () => {
    const m = await import("/src/offline-store.ts");
    return (await m.getDraft("draft-A")).attempt.identity.uploadId;
  });
  assert.equal(restored, "first");
  console.log("PASS reload retained frozen plan");
} finally {
  await browser.close();
  await server.close();
}
