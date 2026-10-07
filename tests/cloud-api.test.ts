import assert from "node:assert/strict";
import { createDemo } from "../supabase/functions/_shared/demo.mjs";
import { minutesBundle } from "./fixtures/minutes-bundle.mjs";
import { decryptApiKey } from "../supabase/functions/_shared/key-crypto.mjs";
import { aacFixture } from "./fixtures/aac.mjs";
import { documentFixtures } from "./fixtures/documents.mjs";
import { attachmentDigest } from "../supabase/functions/_shared/attachments.mjs";
import {
  calendarMeeting,
  calendarEvent,
  editFields,
} from "./fixtures/calendar.mjs";
import { allCalendarEvents, eventKey } from "../supabase/functions/_shared/calendar.mjs";
import {
  createToken,
  hashToken,
} from "../supabase/functions/_shared/session.mjs";

// No network permission is granted to these tests. Every outbound request is mocked.
const owner = "00000000-0000-4000-8000-000000000001";
const tokenA = createToken();
const tokenB = createToken();
const sessions = new Map<string, any>([
  [
    await hashToken(tokenA),
    {
      workspaceId: owner,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ],
  [
    await hashToken(tokenB),
    {
      workspaceId: owner,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ],
]);
const secret = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);
const apiKey = "sk-fake-only-not-a-real-api-key";
const geminiApiKey = "AIza-fake-only-not-a-real-gemini-key";
const rows = new Map<string, any>();
const configs = new Map<string, any>();
const jobs: Promise<unknown>[] = [];
const calls: { route: string; body: any }[] = [];
const audioObjects = new Map<string, Blob>();
const responses = new Map<string, any>();
const usageEvents = new Map<string, any>();
let failSecondRecording = false;
let geminiFailures = 0;
let geminiIncomplete = 0;
let geminiDailyLimit = false;
let clockOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;
const geminiGates = new Map<string, any>();
const realFetch = globalThis.fetch;
const json = (value: unknown, status = 200) => Response.json(value, { status });

Deno.env.set("SUPABASE_URL", "https://kotonoha-test.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-server-only");
Deno.env.set("KOTONOHA_KEY_ENCRYPTION_SECRET", secret);
(globalThis as any).EdgeRuntime = {
  waitUntil: (job: Promise<unknown>) => jobs.push(job),
};
globalThis.fetch = async (input, init: any) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  const headers = new Headers(init?.headers);
  if (url.pathname === "/rest/v1/rpc/kotonoha_auth") {
    const { p_operation: operation, p_payload: payload } = JSON.parse(
      init.body,
    );
    if (operation === "login") {
      if (
        payload.loginId !== "test-shared" ||
        payload.password !== "test-password-only"
      )
        return json({ error: "INVALID_CREDENTIALS" });
      const session = {
        workspaceId: owner,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      sessions.set(payload.tokenHash, session);
      return json(session);
    }
    if (operation === "logout") {
      sessions.delete(payload.tokenHash);
      return json({ ok: true });
    }
    return json(sessions.get(payload.tokenHash) || { error: "INVALID_TOKEN" });
  }
  if (
    [
      "/rest/v1/rpc/kotonoha_store",
      "/rest/v1/rpc/kotonoha_settings",
      "/rest/v1/rpc/kotonoha_audio_upload",
      "/rest/v1/rpc/kotonoha_attachments",
      "/rest/v1/rpc/kotonoha_calendar",
      "/rest/v1/rpc/kotonoha_gemini_gate",
      "/rest/v1/rpc/kotonoha_usage",
    ].includes(url.pathname)
  ) {
    const {
      p_operation: op,
      p_owner: user,
      p_id: id,
      p_payload: payload,
    } = JSON.parse(init?.body as string);
    const config = configs.get(user) || {
      model: "gpt-6-astra",
      encryptedKey: null,
      transcriptionModel: "gpt-transcribe",
      encryptedGeminiKey: null,
    };
    if (url.pathname.endsWith("kotonoha_usage")) {
      if (op === "record") {
        usageEvents.set(`${user}:${payload.id}`, payload);
        return json({ recorded: true });
      }
      const month = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
      });
      const matching = [...usageEvents.entries()]
        .filter(([key, event]) => key.startsWith(`${user}:`) &&
          month.format(new Date(event.createdAt)) === payload.month)
        .map(([, event]) => event)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return json({ month: payload.month, eventCount: matching.length,
        totalUsd: matching.reduce((n, event) => n + (event.costUsd || 0), 0),
        unpricedCount: matching.filter((event) => event.costUsd === null).length,
        events: matching.slice(payload.page * 100, (payload.page + 1) * 100) });
    }
    if (url.pathname.endsWith("kotonoha_settings") && op === "get")
      return json(config);
    if (url.pathname.endsWith("kotonoha_settings") && op === "put") {
      configs.set(user, { ...config, ...payload });
      return json(configs.get(user));
    }
    if (op === "list")
      return json([...rows.values()].filter((row) => row.owner === user));
    if (op === "create") {
      const row = {
        owner: user,
        document: payload.document,
        audioPath: payload.audioPath || null,
        responseId: null,
        leaseUntil: new Date(Date.now() + 240000).toISOString(),
      };
      rows.set(id, row);
      return json(row);
    }
    const row = rows.get(id);
    if (!row || row.owner !== user)
      return json({ message: "NOT_FOUND", code: "P0002" }, 404);
    if (url.pathname.endsWith("kotonoha_gemini_gate")) {
      const gate = geminiGates.get(user) || {
        next: 0,
        active: null,
        reason: "spacing",
      };
      geminiGates.set(user, gate);
      if (op === "reserve") {
        if (
          row.document.runId !== payload.runId ||
          row.document.status !== "transcribing"
        )
          return json(null);
        if (gate.active || gate.next > Date.now())
          return json({
            allowed: false,
            until: new Date(
              Math.max(gate.next, Date.now() + (gate.active ? 10000 : 0)),
            ).toISOString(),
            reason: gate.reason,
          });
        gate.active = payload.runId;
        return json({ allowed: true });
      }
      if (op === "finish") {
        if (gate.active !== payload.runId) return json(null);
        gate.active = null;
        gate.next = Date.now() + Math.max(30000, payload.delayMs || 0);
        gate.reason = payload.reason || "spacing";
        return json({
          until: new Date(gate.next).toISOString(),
          reason: gate.reason,
        });
      }
      assert.fail("Unexpected Gemini gate operation");
    }
    if (url.pathname.endsWith("kotonoha_calendar")) {
      if (
        ["uploading", "transcribing", "analyzing"].includes(row.document.status)
      )
        return json({ message: "BUSY" }, 400);
      row.document.calendarOverrides ||= {};
      if (op === "set")
        row.document.calendarOverrides[payload.eventId] = payload.value;
      else if (op === "reset")
        delete row.document.calendarOverrides[payload.eventId];
      else throw new Error("Unexpected calendar operation");
      return json(row);
    }
    if (
      url.pathname.endsWith("kotonoha_attachments") &&
      ["add", "remove"].includes(op)
    ) {
      if (["transcribing", "analyzing"].includes(row.document.status))
        return json({ message: "BUSY" }, 400);
      const files = row.document.attachments || [];
      if (op === "add") {
        row.document.attachments = [...files, payload.attachment];
      }
      if (op === "remove") {
        if (row.document.status === "uploading")
          return json({ message: "BUSY" }, 400);
        row.document.removedAttachments = [
          ...(row.document.removedAttachments || []),
          files.find((f: any) => f.id === payload.attachmentId),
        ];
        row.document.attachments = files.filter(
          (f: any) => f.id !== payload.attachmentId,
        );
      }
    }
    if (op === "append") {
      if (
        row.document.status !== "uploading" ||
        payload.index !== row.document.audioParts.length
      )
        return json({ message: "UPLOAD_ORDER" }, 400);
      row.document.audioParts.push(payload.part);
      row.audioPath ||= payload.part.audioPath;
    }
    if (op === "complete" && row.document.status === "uploading") {
      if (
        row.document.audioParts.length !== row.document.uploadPlan.length ||
        (row.document.attachments || []).length !==
          (row.document.attachmentPlan || []).length
      )
        return json({ message: "UPLOAD_INCOMPLETE" }, 400);
      Object.assign(row.document, {
        status: row.document.audioParts.length ? "transcribing" : "analyzing",
        partReady: true,
        runId: payload.runId,
      });
    }
    if (op === "next") {
      if (
        !row.document.partReady ||
        !["transcribing", "analyzing"].includes(row.document.status)
      )
        return json(null);
      Object.assign(row.document, { partReady: false, runId: payload.runId });
    }
    if (op === "job_update" && row.document.runId === payload.runId) {
      Object.assign(row.document, payload.patch);
      if ("responseId" in payload) row.responseId = payload.responseId;
    }
    if (op === "claim" || op === "patch") Object.assign(row.document, payload);
    if (op === "claim") row.responseId = null;
    if (op === "delete") {
      rows.delete(id);
      return json({ deleted: true });
    }
    return json(row);
  }
  if (
    url.hostname === "generativelanguage.googleapis.com" &&
    url.pathname === "/upload/v1beta/files"
  ) {
    assert.equal(url.searchParams.get("key"), geminiApiKey);
    calls.push({ route: url.pathname, body: "start" });
    return new Response(null, {
      headers: {
        "x-goog-upload-url": "https://gemini-upload.invalid/session",
      },
    });
  }
  if (url.hostname === "gemini-upload.invalid") {
    assert.equal(headers.get("x-goog-upload-command"), "upload, finalize");
    calls.push({ route: url.pathname, body: "upload" });
    return json({
      file: {
        name: "files/test-audio",
        uri: "https://generativelanguage.googleapis.com/v1beta/files/test-audio",
      },
    });
  }
  if (
    url.hostname === "generativelanguage.googleapis.com" &&
    url.pathname === "/v1beta/interactions"
  ) {
    assert.equal(headers.get("x-goog-api-key"), geminiApiKey);
    const body = JSON.parse(init.body);
    assert.deepEqual(
      body.generation_config.transcription_config.language_codes,
      ["ja-JP"],
    );
    assert.equal(body.model, "gemini-3.5-transcribe");
    assert.equal(body.store, false);
    assert.equal(body.input[0].type, "audio");
    assert.equal(body.input[0].mime_type, "audio/wav");
    assert.equal(
      body.input[0].uri,
      "https://generativelanguage.googleapis.com/v1beta/files/test-audio",
    );
    calls.push({ route: url.pathname, body });
    if (geminiFailures > 0) {
      geminiFailures--;
      return json(
        {
          error: {
            status: "RESOURCE_EXHAUSTED",
            details: geminiDailyLimit
              ? [
                  {
                    "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                    violations: [{ quotaId: "TranscribeRequestsPerDay" }],
                  },
                ]
              : [
                  {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    retryDelay: "90s",
                  },
                ],
          },
        },
        429,
      );
    }
    if (geminiIncomplete > 0) {
      geminiIncomplete--;
      return json({
        id: `gemini-${calls.length}`,
        status: "incomplete",
        usage: { total_input_tokens: 1500, total_output_tokens: 175 },
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: "途中まで" }],
          },
        ],
      });
    }
    return json({
      id: `gemini-${calls.length}`,
      status: "completed",
      usage: { total_input_tokens: 1500, total_output_tokens: 175 },
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: "Geminiで文字起こししました。" }],
        },
      ],
    });
  }
  if (
    url.hostname === "generativelanguage.googleapis.com" &&
    url.pathname === "/v1beta/files/test-audio" &&
    init?.method === "DELETE"
  ) {
    assert.equal(url.searchParams.get("key"), geminiApiKey);
    calls.push({ route: url.pathname, body: "delete" });
    return json({});
  }
  if (url.hostname === "api.openai.com") {
    assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
    if (url.pathname === "/v1/audio/transcriptions") {
      const form = init?.body as FormData;
      assert.equal(form.get("model"), "gpt-transcribe");
      assert.deepEqual(form.getAll("languages[]"), ["ja"]);
      assert.equal(form.get("language"), null);
      assert.equal(form.get("response_format"), "json");
      const file = form.get("file") as File;
      assert.ok(file instanceof File);
      calls.push({
        route: url.pathname,
        body: { name: file.name, type: file.type, prompt: form.get("prompt") },
      });
      if (file.name.endsWith(".m4a")) {
        assert.equal(file.type, "audio/mp4");
        assert.equal(
          new TextDecoder().decode(
            new Uint8Array(await file.arrayBuffer()).slice(4, 8),
          ),
          "ftyp",
        );
      }
      if (
        (file.name.startsWith("recording-2") ||
          file.name.endsWith("recording-1-2.wav")) &&
        failSecondRecording
      )
        return json({ error: { message: "test-only failure" } }, 429);
      return json({
        id: `transcription-${calls.length}`,
        usage: { type: "duration", seconds: 60 },
        text: file.name.startsWith("recording-2")
          ? "後半で実施が決定しました。"
          : "佐藤さんが来週までに企画書を作成します。",
      });
    }
    if (init?.method === "POST" && url.pathname === "/v1/responses") {
      const body = JSON.parse(init.body as string);
      calls.push({ route: url.pathname, body });
      if (body.store === false) {
        return json({ id: `insight-${calls.length}`, status: "completed",
          usage: { input_tokens: 1000, output_tokens: 100 },
          output: [{ type: "message", content: [{ type: "output_text", text: body.text ? '{"tags":["共有","進捗"]}' : "## 要約\nクラウド期間サマリー" }] }],
        });
      }
      assert.equal(body.background, true);
      assert.equal(body.store, true);
      assert.equal(body.text.format.type, "json_schema");
      assert.equal(body.text.format.strict, true);
      assert.deepEqual(body.text.format.schema.properties.formats.required, ["brief", "standard", "detailed"]);
      const id = `resp-${calls.length}`;
      responses.set(id, minutesBundle((createDemo() as any).minutes));
      return json({ id, status: "queued" });
    }
    return json({
      id: url.pathname.split("/").pop(),
      status: "completed",
      usage: { input_tokens: 1000, output_tokens: 200,
        input_tokens_details: { cached_tokens: 100 },
        output_tokens_details: { reasoning_tokens: 50 } },
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify(
                responses.get(url.pathname.split("/").pop()!),
              ),
            },
          ],
        },
      ],
    });
  }
  if (url.pathname.startsWith("/storage/v1/object/")) {
    if (url.pathname.includes("/sign/"))
      return json({
        signedURL: `/object/signed/${url.pathname.split("/").pop()}?token=test`,
      });
    if (init?.method === "DELETE") {
      for (const prefix of JSON.parse(init.body).prefixes)
        audioObjects.delete(`${url.pathname}/${prefix}`);
      return json([]);
    }
    if (init?.method === "POST") {
      const body = init.body;
      const blob =
        body instanceof FormData
          ? [...body.values()].find((value) => value instanceof Blob)
          : body;
      assert.ok(blob instanceof Blob);
      audioObjects.set(url.pathname, blob);
      return json({ Key: "saved" });
    }
    const blob = audioObjects.get(url.pathname);
    assert.ok(blob, `stored audio missing: ${url.pathname}`);
    return new Response(blob);
  }
  throw new Error(`Unexpected network request: ${url.pathname}`);
};
const { handler } =
  await import("../supabase/functions/kotonoha-api/handler.ts");

function request(route: string, token = "valid-a", init: RequestInit = {}) {
  token = token === "valid-a" ? tokenA : token === "valid-b" ? tokenB : token;
  return handler(
    new Request(
      `https://kotonoha-test.invalid/functions/v1/kotonoha-api${route}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://marugo-s.github.io",
          ...(init.body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
          ...init.headers,
        },
      },
    ),
  );
}
async function drain() {
  await Promise.all(jobs.splice(0));
}

Deno.test(
  "Cloud HTTP: fixed login, shared sessions, encrypted settings, upload, GPT pipeline and edits",
  async () => {
    try {
      const durationFixture = { ...createDemo(), duration: null, uploadPlan: [{}, {}], audioParts: [{ duration: 600 }, { duration: 33.626122 }] };
      rows.set(durationFixture.id, { owner, document: durationFixture, audioPath: null, responseId: null });
      const durationDetail = await (await request(`/meetings/${durationFixture.id}`, "valid-a")).json();
      const durationList = await (await request("/meetings", "valid-b")).json();
      for (const result of [durationDetail, durationList.find((m: any) => m.id === durationFixture.id)]) {
        assert.equal(result.duration, 633.626122);
        assert.equal(result.audioParts, undefined);
        assert.equal(result.uploadPlan, undefined);
      }
      assert.equal(rows.get(durationFixture.id).document.duration, null);
      rows.delete(durationFixture.id);
      const calendar = calendarMeeting(),
        eventId = eventKey(calendarEvent),
        calRoute = `/meetings/${calendar.id}`;
      rows.set(calendar.id, {
        owner,
        document: calendar,
        audioPath: null,
        responseId: null,
      });
      const patch = {
        method: "PATCH",
        body: JSON.stringify({
          ...editFields(calendarEvent),
          date: "2026-10-16",
          owner: "田中",
        }),
      };
      assert.equal(
        (await request(`${calRoute}/calendar/${eventId}`, "anonymous", patch))
          .status,
        401,
      );
      assert.equal(
        (await request(`${calRoute}/calendar/${eventId}`, "valid-a", patch))
          .status,
        200,
      );
      const fromB = await (await request(calRoute, "valid-b")).json();
      assert.equal(fromB.calendarOverrides[eventId].event.date, "2026-10-16");
      assert.equal(
        fromB.calendarOverrides[eventId].original.date,
        "2026-10-15",
      );
      assert.equal(
        (
          await request(calRoute, "valid-b", {
            method: "PATCH",
            body: JSON.stringify({ markdown: "# 全員に共有する手動の本文" }),
          })
        ).status,
        200,
      );
      assert.equal(
        (await (await request(calRoute, "valid-a")).json()).markdown,
        "# 全員に共有する手動の本文",
      );
      assert.equal(
        rows.get(calendar.id).document.calendarOverrides[eventId].event.owner,
        "田中",
      );
      assert.equal(
        (
          await request(
            `${calRoute}/calendar/0000000000000000`,
            "valid-a",
            patch,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(`${calRoute}/calendar/${eventId}`, "valid-b", {
            method: "PATCH",
            body: JSON.stringify({
              ...editFields(calendarEvent),
              date: "2026-02-30",
            }),
          })
        ).status,
        400,
      );
      assert.equal(calls.length, 0, "manual edits must never call OpenAI");
      assert.equal(
        (
          await request(`${calRoute}/calendar/${eventId}`, "valid-b", {
            method: "DELETE",
          })
        ).status,
        200,
      );
      assert.deepEqual(rows.get(calendar.id).document.calendarOverrides, {});
      const secondEvent = { ...calendarEvent, title: "もう一つの予定" };
      rows.get(calendar.id).document.minutes.scheduleEvents.push(secondEvent);
      const secondId = eventKey(secondEvent);
      for (const id of [eventId, secondId]) {
        assert.equal((await request(`${calRoute}/calendar/${id}/hide`, "valid-a", {
          method: "POST",
        })).status, 200);
      }
      assert.equal(allCalendarEvents([rows.get(calendar.id).document]).length, 0);
      assert.equal(rows.get(calendar.id).document.minutes.scheduleEvents.length, 2);
      assert.equal((await request(`${calRoute}/calendar/${eventId}/restore`, "valid-b", {
        method: "POST",
      })).status, 200);
      assert.equal(allCalendarEvents([rows.get(calendar.id).document]).length, 1);
      assert.equal((await request(`${calRoute}/calendar/${secondId}/restore`, "valid-b", {
        method: "POST",
      })).status, 200);
      assert.deepEqual(rows.get(calendar.id).document.calendarOverrides, {});
      rows.delete(calendar.id);
      assert.equal((await request("/meetings", "invalid")).status, 401);
      assert.equal((await request("/meetings", "anonymous")).status, 401);
      assert.equal((await request("/meetings", createToken())).status, 401);
      const invalidLogin = await request("/auth/login", "", {
        method: "POST",
        body: JSON.stringify({
          loginId: "test-shared",
          password: "wrong-password",
        }),
      });
      assert.equal(invalidLogin.status, 401);
      const loggedIn = await request("/auth/login", "", {
        method: "POST",
        body: JSON.stringify({
          loginId: "test-shared",
          password: "test-password-only",
        }),
      });
      assert.equal(loggedIn.status, 200);
      const loginSession = await loggedIn.json();
      assert.ok(loginSession.token.startsWith("ktn_"));
      assert.equal(loginSession.workspaceId, undefined);
      assert.equal(
        (await request("/auth/session", loginSession.token)).status,
        200,
      );
      assert.equal(
        (
          await handler(
            new Request(
              "https://kotonoha-test.invalid/functions/v1/kotonoha-api/meetings",
            ),
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await request("/meetings", "valid-a", {
            headers: { Origin: "https://untrusted.invalid" },
          })
        ).status,
        403,
      );
      const options = await request("/settings", "", { method: "OPTIONS" });
      assert.equal(options.status, 204);
      assert.equal(
        options.headers.get("Access-Control-Allow-Origin"),
        "https://marugo-s.github.io",
      );
      const save = await request("/settings", "valid-a", {
        method: "PUT",
        body: JSON.stringify({ model: "gpt-6-astra", apiKey }),
      });
      assert.equal(save.status, 200);
      assert.ok(!(await save.text()).includes(apiKey));
      assert.equal(
        await decryptApiKey(configs.get(owner).encryptedKey, owner, secret),
        apiKey,
      );
      assert.equal(
        (await (await request("/settings", "valid-b")).json()).configured,
        true,
      );
      const geminiSave = await request("/settings", "valid-a", {
        method: "PUT",
        body: JSON.stringify({
          model: "gpt-6-astra",
          transcriptionModel: "gemini-3.5-transcribe",
          geminiApiKey,
        }),
      });
      assert.equal(geminiSave.status, 200);
      const geminiSettings = await geminiSave.json();
      assert.equal(geminiSettings.geminiConfigured, true);
      assert.ok(!JSON.stringify(geminiSettings).includes(geminiApiKey));
      assert.equal(
        await decryptApiKey(
          configs.get(owner).encryptedGeminiKey,
          owner,
          secret,
        ),
        geminiApiKey,
      );
      const geminiForm = new FormData();
      geminiForm.set("title", "Gemini文字起こし会議");
      geminiForm.set("date", "2026-09-24");
      geminiForm.set(
        "audio",
        new File([new Uint8Array(44)], "gemini.wav", {
          type: "audio/wav",
        }),
      );
      const geminiCreated = await request("/meetings", "valid-a", {
        method: "POST",
        body: geminiForm,
      });
      assert.equal(
        geminiCreated.status,
        202,
        await geminiCreated.clone().text(),
      );
      const geminiMeeting = await geminiCreated.json();
      await drain();
      await request("/meetings");
      await drain();
      await request("/meetings");
      const geminiDone = await (
        await request(`/meetings/${geminiMeeting.id}`)
      ).json();
      assert.equal(geminiDone.status, "done");
      assert.equal(geminiDone.transcriptionModel, "gemini-3.5-transcribe");
      assert.equal(geminiDone.transcript, "Geminiで文字起こししました。");
      const usageMonth = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
      }).format(new Date());
      const geminiUsage = await (await request(`/usage?month=${usageMonth}&page=0`, "valid-b")).json();
      const geminiEvent = geminiUsage.events.find((event: any) =>
        event.meetingId === geminiMeeting.id && event.kind === "transcription");
      assert.equal(geminiEvent.inputTokens, 1500);
      assert.equal(geminiEvent.outputTokens, 175);
      assert.equal(geminiEvent.costUsd, (1500 * 2 + 175 * 12) / 1_000_000);
      assert.ok(geminiUsage.events.some((event: any) =>
        event.meetingId === geminiMeeting.id && event.kind === "minutes"));
      assert.ok(geminiEvent.runId);
      assert.ok(geminiUsage.events.some((event: any) =>
        event.meetingId === geminiMeeting.id && event.kind === "minutes" &&
        event.runId === geminiEvent.runId));
      assert.ok(calls.some((c) => c.route === "/v1beta/interactions"));
      assert.ok(
        calls.some(
          (c) => c.route === "/v1beta/files/test-audio" && c.body === "delete",
        ),
      );
      assert.equal(
        (
          await request(`/meetings/${geminiMeeting.id}`, "valid-a", {
            method: "DELETE",
          })
        ).status,
        204,
      );
      // Seven chunks represent 65 minutes. Audio inference is mocked; ordering,
      // durable cooldowns, browser reload and quota limits exercise the real handler.
      const geminiCount = () =>
        calls.filter((c) => c.route === "/v1beta/interactions").length;
      async function createGeminiUpload(count: number) {
        const response = await request("/uploads", "valid-a", {
          method: "POST",
          body: JSON.stringify({
            metadata: { title: "Gemini再開テスト", date: "2026-09-24" },
            sources: [{ name: "65-minutes.wav", size: 62_400_044 }],
            parts: Array.from({ length: count }, (_, i) => ({
              name: `recording-1-${i + 1}.wav`,
              size: 44,
              sourceIndex: 0,
              partNumber: i + 1,
              duration: i === 6 ? 300 : 600,
            })),
          }),
        });
        assert.equal(response.status, 201, await response.clone().text());
        const draft = await response.json();
        for (let i = 0; i < count; i++)
          assert.equal(
            (
              await request(
                `/meetings/${draft.id}/parts?index=${i}`,
                "valid-b",
                {
                  method: "POST",
                  body: new Blob([new Uint8Array(44)], { type: "audio/wav" }),
                  headers: { "Content-Type": "audio/wav" },
                },
              )
            ).status,
            200,
          );
        assert.equal(
          (
            await request(`/meetings/${draft.id}/complete`, "valid-a", {
              method: "POST",
            })
          ).status,
          202,
        );
        await drain();
        return draft.id;
      }
      async function pollTogether() {
        await Promise.all([
          request("/meetings", "valid-a"),
          request("/meetings", "valid-b"),
        ]);
        await drain();
      }
      function advanceWait(id: string) {
        const until = rows.get(id).document.transcriptionWait?.until;
        assert.ok(until, "expected durable wait");
        clockOffset += Math.max(0, Date.parse(until) - Date.now()) + 1;
      }
      const longStart = geminiCount();
      const longId = await createGeminiUpload(7);
      // Previous meeting left the shared gate in its 30 second cooldown.
      assert.equal(
        rows.get(longId).document.transcriptionWait.reason,
        "spacing",
      );
      await pollTogether();
      assert.equal(geminiCount(), longStart, "no requests before cooldown");
      advanceWait(longId);
      await pollTogether();
      assert.equal(geminiCount(), longStart + 1);
      assert.equal(
        rows.get(longId).document.audioParts[0].transcript,
        "Geminiで文字起こししました。",
      );
      await pollTogether(); // persist the next spacing wait
      advanceWait(longId);
      geminiFailures = 1;
      await pollTogether();
      const rateWait = rows.get(longId).document.transcriptionWait;
      assert.equal(rateWait.reason, "rate_limit");
      assert.equal(rateWait.attempt, 1);
      assert.ok(
        Date.parse(rateWait.until) - Date.now() > 89_000,
        "honor Google's 90s RetryInfo",
      );
      assert.equal(
        rows.get(longId).document.audioParts.filter((p: any) => p.transcript)
          .length,
        1,
      );
      // A new session/page read does not re-send a paid request while waiting.
      const beforeReload = geminiCount();
      await request(`/meetings/${longId}`, "valid-b");
      await pollTogether();
      assert.equal(geminiCount(), beforeReload);
      assert.equal(
        (
          await request(`/meetings/${longId}/retry`, "valid-a", {
            method: "POST",
          })
        ).status,
        409,
      );
      advanceWait(longId);
      await pollTogether();
      assert.equal(rows.get(longId).document.geminiRetryCount, 0);
      for (
        let guard = 0;
        guard < 30 && rows.get(longId).document.status !== "done";
        guard++
      ) {
        if (rows.get(longId).document.transcriptionWait) advanceWait(longId);
        await pollTogether();
      }
      assert.equal(rows.get(longId).document.status, "done");
      const longUsage = [...usageEvents.values()].filter((event: any) =>
        event.meetingId === longId);
      assert.ok(longUsage.length >= 2);
      assert.ok(longUsage.every((event: any) =>
        event.runId === rows.get(longId).document.analysisId));
      assert.equal(
        rows.get(longId).document.audioParts.filter((p: any) => p.transcript)
          .length,
        7,
      );
      assert.equal(
        geminiCount() - longStart,
        8,
        "7 chunks plus only the failed chunk once more",
      );
      assert.equal(
        (await request(`/meetings/${longId}`, "valid-a", { method: "DELETE" }))
          .status,
        204,
      );

      // Two meetings share one workspace throttle, including the failure cooldown.
      const parallelStart = geminiCount();
      const parallelA = await createGeminiUpload(1);
      const parallelB = await createGeminiUpload(1);
      advanceWait(parallelA);
      await pollTogether();
      assert.equal(geminiCount(), parallelStart + 1);
      assert.equal(
        rows.get(parallelB).document.transcriptionWait.reason,
        "spacing",
      );
      await pollTogether();
      advanceWait(parallelB);
      await pollTogether();
      await pollTogether();
      await pollTogether();
      for (let guard = 0; guard < 10 && [parallelA, parallelB].some(
        (id) => rows.get(id).document.status !== "done"); guard++) {
        for (const id of [parallelA, parallelB]) {
          if (rows.get(id).document.transcriptionWait) advanceWait(id);
        }
        await pollTogether();
      }
      for (const id of [parallelA, parallelB]) {
        assert.equal(rows.get(id).document.status, "done");
        assert.equal(
          (await request(`/meetings/${id}`, "valid-a", { method: "DELETE" }))
            .status,
          204,
        );
      }
      assert.equal(geminiCount(), parallelStart + 2);

      const exhaustedStart = geminiCount();
      geminiFailures = 6;
      const exhaustedId = await createGeminiUpload(1);
      for (let i = 0; i < 6; i++) {
        advanceWait(exhaustedId);
        await pollTogether();
        if (i < 5) {
          const m = rows.get(exhaustedId).document;
          assert.equal(m.status, "transcribing");
          assert.equal(m.transcriptionWait.attempt, i + 1);
          // Late retries exceed the usual 4-minute lease but must not time out.
          if (i === 4) {
            clockOffset += 240_001;
            await pollTogether();
            assert.equal(rows.get(exhaustedId).document.status, "transcribing");
          }
        }
      }
      assert.equal(rows.get(exhaustedId).document.status, "error");
      assert.equal(
        rows.get(exhaustedId).document.diagnosticCode,
        "GEMINI_RETRIES_EXHAUSTED",
      );
      await pollTogether();
      assert.equal(geminiCount() - exhaustedStart, 6);
      assert.equal(
        (
          await request(`/meetings/${exhaustedId}`, "valid-a", {
            method: "DELETE",
          })
        ).status,
        204,
      );
      geminiFailures = 1;
      geminiDailyLimit = true;
      const dailyId = await createGeminiUpload(1);
      advanceWait(dailyId);
      await pollTogether();
      assert.equal(rows.get(dailyId).document.status, "error");
      assert.equal(
        rows.get(dailyId).document.diagnosticCode,
        "GEMINI_QUOTA_EXHAUSTED",
      );
      assert.equal(rows.get(dailyId).document.transcriptionWait, null);
      assert.equal(
        (await request(`/meetings/${dailyId}`, "valid-a", { method: "DELETE" }))
          .status,
        204,
      );
      geminiDailyLimit = false;
      // Gemini ends without a complete transcript: only that part moves to GPT
      // Transcribe, in the next invocation, and Gemini is not asked again.
      geminiIncomplete = 1;
      const openaiTranscriptions = () =>
        calls.filter((c) => c.route === "/v1/audio/transcriptions").length;
      const incompleteGemini = geminiCount();
      const incompleteOpenai = openaiTranscriptions();
      const incompleteId = await createGeminiUpload(1);
      advanceWait(incompleteId);
      await pollTogether();
      // Concurrent polls may already have run the OpenAI step; the mark persists.
      const marked = rows.get(incompleteId).document;
      assert.notEqual(marked.status, "error");
      assert.equal(marked.error, null);
      assert.equal(marked.diagnosticCode, "GEMINI_FALLBACK_INCOMPLETE");
      assert.deepEqual(marked.audioParts[0].transcriptionFallback, {
        model: "gpt-transcribe",
        geminiStatus: "incomplete",
      });
      for (
        let guard = 0;
        guard < 10 && rows.get(incompleteId).document.status !== "done";
        guard++
      ) {
        if (rows.get(incompleteId).document.transcriptionWait)
          advanceWait(incompleteId);
        await pollTogether();
      }
      const recovered = await (
        await request(`/meetings/${incompleteId}`, "valid-b")
      ).json();
      assert.equal(recovered.status, "done");
      assert.equal(
        recovered.transcript,
        "佐藤さんが来週までに企画書を作成します。",
      );
      assert.deepEqual(
        recovered.recordings.map((r: any) => r.fallbackModel),
        ["gpt-transcribe"],
      );
      assert.equal(geminiCount() - incompleteGemini, 1);
      assert.equal(openaiTranscriptions() - incompleteOpenai, 1);
      assert.ok(
        [...usageEvents.values()].some(
          (event: any) =>
            event.meetingId === incompleteId &&
            event.kind === "transcription" &&
            event.model === "gpt-transcribe",
        ),
      );
      assert.equal(
        (
          await request(`/meetings/${incompleteId}`, "valid-a", {
            method: "DELETE",
          })
        ).status,
        204,
      );
      clockOffset = 0;
      const openaiBeforeModels = openaiTranscriptions();
      for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
        await request("/settings", "valid-a", {
          method: "PUT",
          body: JSON.stringify({
            model,
            transcriptionModel: "gpt-transcribe",
          }),
        });
        const form = new FormData();
        form.set("title", "テスト会議");
        form.set("date", "2026-09-23");
        if (model === "gpt-6-sol")
          form.set(
            "audio",
            new File([new Uint8Array(44)], "meeting.wav", {
              type: "audio/wav",
            }),
          );
        else form.set("transcript", "議論の結果、来週から開始します。");
        const created = await request("/meetings", "valid-a", {
          method: "POST",
          body: form,
        });
        assert.equal(created.status, 202, await created.clone().text());
        const meeting = await created.json();
        assert.equal(meeting.runId, undefined);
        assert.equal(meeting.analysisId, undefined);
        await drain();
        assert.equal(
          calls.filter((c) => c.route === "/v1/responses").at(-1)?.body.model,
          model,
        );
        assert.equal(
          (await request(`/meetings/${meeting.id}`, "valid-b")).status,
          200,
        );
        const list = await (await request("/meetings")).json();
        const done = list.find((m: any) => m.id === meeting.id);
        assert.equal(done.status, "done");
        assert.ok(done.markdown.includes("決定事項"));
        assert.ok(done.transcript.length);
        assert.equal(done.hasAudio, model === "gpt-6-sol");
        assert.equal(
          (await (await request("/meetings", "valid-b")).json()).length,
          1,
        );
        const renamed = await request(`/meetings/${meeting.id}`, "valid-a", {
          method: "PATCH",
          body: JSON.stringify({ title: "変更後の会議" }),
        });
        const renamedMeeting = await renamed.json();
        assert.equal(renamedMeeting.title, "変更後の会議");
        assert.ok(renamedMeeting.markdown.startsWith("# 変更後の会議\n"));
        assert.equal(
          (await (await request(`/meetings/${meeting.id}`, "valid-b")).json()).title,
          "変更後の会議",
        );
        assert.equal(
          (await request(`/meetings/${meeting.id}`, "valid-b", {
            method: "PATCH", body: JSON.stringify({ title: " " }),
          })).status,
          400,
        );
        const edited = await request(`/meetings/${meeting.id}`, "valid-a", {
          method: "PATCH",
          body: JSON.stringify({ markdown: "手動修正" }),
        });
        assert.equal((await edited.json()).markdown, "手動修正");
        assert.equal(
          (await (await request(`/meetings/${meeting.id}`, "valid-b")).json())
            .markdown,
          "手動修正",
        );
        const afterSecondRename = await (
          await request(`/meetings/${meeting.id}`, "valid-a", {
            method: "PATCH", body: JSON.stringify({ title: "さらに変更" }),
          })
        ).json();
        assert.equal(afterSecondRename.markdown, "手動修正");
        assert.equal(
          (
            await request(`/meetings/${meeting.id}`, "valid-b", {
              method: "DELETE",
            })
          ).status,
          204,
        );
      }
      assert.equal(openaiTranscriptions() - openaiBeforeModels, 1);
      const usageAfterDelete = await (await request(`/usage?month=${usageMonth}&page=0`)).json();
      assert.ok(usageAfterDelete.events.some((event: any) => event.meetingId === geminiMeeting.id),
        "deleting a meeting must preserve its API usage history");
      assert.ok(usageAfterDelete.events.some((event: any) =>
        event.kind === "transcription" && event.model === "gpt-transcribe" &&
        event.audioSeconds === 60 && event.costUsd === 0.0045));
      assert.ok(usageAfterDelete.events.some((event: any) =>
        event.kind === "minutes" && event.model === "gpt-6-sol" &&
        event.inputTokens === 1000 && event.cachedInputTokens === 100 &&
        event.reasoningTokens === 50));
      // Same workspace, mixed formats, durable partial results and retry only missing parts.
      const combined = new FormData();
      combined.set("title", "分割録音の統合テスト");
      combined.set("date", "2026-09-23");
      combined.append("audio", new File([aacFixture], "前半.AAC"));
      combined.append(
        "audio",
        new File([new Uint8Array(44)], "後半.wav", { type: "audio/wav" }),
      );
      failSecondRecording = true;
      const batchResponse = await request("/meetings", "valid-a", {
        method: "POST",
        body: combined,
      });
      assert.equal(
        batchResponse.status,
        202,
        await batchResponse.clone().text(),
      );
      const batch = await batchResponse.json();
      assert.equal(batch.audioParts, undefined);
      assert.deepEqual(
        batch.recordings.map((part: any) => part.fileName),
        ["前半.AAC", "後半.wav"],
      );
      await drain();
      const failed = await (
        await request(`/meetings/${batch.id}`, "valid-b")
      ).json();
      assert.equal(failed.status, "error");
      assert.match(failed.error, /録音2/);
      assert.deepEqual(
        failed.recordings.map((part: any) => part.transcribed),
        [true, false],
      );
      const beforeRetry = calls.length;
      failSecondRecording = false;
      assert.equal(
        (
          await request(`/meetings/${batch.id}/retry`, "valid-b", {
            method: "POST",
          })
        ).status,
        202,
      );
      await drain();
      const retriedCalls = calls.slice(beforeRetry);
      assert.equal(
        retriedCalls.filter((call) => call.route === "/v1/audio/transcriptions")
          .length,
        1,
      );
      assert.equal(retriedCalls[0].body.name, "recording-2.wav");
      const summaryInput = retriedCalls.find(
        (call) => call.route === "/v1/responses",
      )!.body.input[1].content;
      assert.match(summaryInput, /【録音 1】.*佐藤.*【録音 2】.*後半/);
      const batchDone = (
        await (await request("/meetings", "valid-b")).json()
      ).find((m: any) => m.id === batch.id);
      assert.equal(batchDone.status, "done");
      assert.deepEqual(
        batchDone.recordings.map((part: any) => part.transcribed),
        [true, true],
      );
      assert.match(
        (await (await request(`/meetings/${batch.id}/audio?part=0`)).json())
          .url,
        /recording-1.m4a/,
      );
      assert.match(
        (await (await request(`/meetings/${batch.id}/audio?part=1`)).json())
          .url,
        /recording-2.wav/,
      );
      assert.equal(
        (await request(`/meetings/${batch.id}/audio?part=2`)).status,
        404,
      );
      assert.equal(
        (await request(`/meetings/${batch.id}/audio?part=-1`)).status,
        404,
      );

      const beforeFiles = audioObjects.size;
      const beforeMeetings = rows.size;
      const broken = new FormData();
      broken.set("title", "失敗テスト");
      broken.set("date", "2026-09-23");
      broken.append("audio", new File([aacFixture], "valid.aac"));
      broken.append(
        "audio",
        new File([aacFixture.slice(0, -1)], "truncated.aac"),
      );
      assert.equal(
        (
          await request("/meetings", "valid-a", {
            method: "POST",
            body: broken,
          })
        ).status,
        400,
      );
      assert.equal(
        audioObjects.size,
        beforeFiles,
        "cleanup all previously uploaded parts",
      );
      assert.equal(rows.size, beforeMeetings);
      const tooMany = new FormData();
      tooMany.set("title", "上限テスト");
      tooMany.set("date", "2026-09-23");
      for (let i = 0; i < 6; i++)
        tooMany.append("audio", new File([aacFixture], `${i}.aac`));
      assert.equal(
        (
          await request("/meetings", "valid-a", {
            method: "POST",
            body: tooMany,
          })
        ).status,
        400,
      );
      // New staged protocol: upload all parts first, then one transcription per
      // worker lease. Concurrent polling must not duplicate OpenAI requests.
      const plan = {
        metadata: { title: "100MB境界", date: "2026-09-23" },
        sources: [{ name: "large.wav", size: 100_000_000 }],
        parts: Array.from({ length: 7 }, (_, i) => ({
          name: `recording-1-${i + 1}.wav`,
          size: 44,
          sourceIndex: 0,
          partNumber: i + 1,
          duration: 1,
        })),
      };
      const createUpload = () =>
        request("/uploads", "valid-a", {
          method: "POST",
          body: JSON.stringify(plan),
        });
      const draftResponse = await createUpload();
      assert.equal(draftResponse.status, 201);
      const draft = await draftResponse.json();
      assert.equal(draft.uploadPlan, undefined);
      assert.equal(draft.status, "uploading");
      assert.equal(
        (
          await request(`/meetings/${draft.id}/complete`, "valid-a", {
            method: "POST",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(`/meetings/${draft.id}/retry`, "valid-a", {
            method: "POST",
          })
        ).status,
        409,
      );
      const putPart = (index: number, bytes = 44) =>
        request(`/meetings/${draft.id}/parts?index=${index}`, "valid-b", {
          method: "POST",
          body: new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
          headers: { "Content-Type": "audio/wav" },
        });
      assert.equal((await putPart(1)).status, 409);
      assert.equal((await putPart(0, 43)).status, 400);
      const transcriptionCount = () =>
        calls.filter((c) => c.route.endsWith("/transcriptions")).length;
      const beforeCount = transcriptionCount();
      for (let i = 0; i < 7; i++) assert.equal((await putPart(i)).status, 200);
      assert.equal((await putPart(6)).status, 409);
      assert.equal(
        transcriptionCount(),
        beforeCount,
        "upload does not call OpenAI",
      );
      assert.equal(
        (
          await request(`/meetings/${draft.id}/complete`, "valid-a", {
            method: "POST",
          })
        ).status,
        202,
      );
      await drain();
      assert.equal(transcriptionCount(), beforeCount + 1);
      failSecondRecording = true;
      await Promise.all([
        request("/meetings"),
        request("/meetings", "valid-b"),
      ]);
      await drain();
      assert.equal(
        transcriptionCount(),
        beforeCount + 2,
        "one claim even with concurrent shared sessions",
      );
      assert.equal(rows.get(draft.id).document.status, "error");
      assert.ok(rows.get(draft.id).document.audioParts[0].transcript);
      failSecondRecording = false;
      assert.equal(
        (
          await request(`/meetings/${draft.id}/retry`, "valid-b", {
            method: "POST",
          })
        ).status,
        202,
      );
      await drain();
      for (let i = 0; i < 8; i++) {
        await request("/meetings");
        await drain();
      }
      assert.equal(rows.get(draft.id).document.status, "done");
      assert.equal(
        transcriptionCount(),
        beforeCount + 8,
        "7 successful calls and 1 failed; no re-transcription of saved chunks",
      );
      assert.ok(
        calls.filter((c) => c.route.endsWith("/transcriptions")).at(-1)!.body
          .prompt,
      );
      assert.ok(rows.get(draft.id).document.transcript.includes("【録音 7】"));
      const abandoned = await (await createUpload()).json();
      const filesBefore = audioObjects.size;
      await request(`/meetings/${abandoned.id}/parts?index=0`, "valid-a", {
        method: "POST",
        body: new Blob([new Uint8Array(44)]),
        headers: { "Content-Type": "application/octet-stream" },
      });
      assert.equal(audioObjects.size, filesBefore + 1);
      await request(`/meetings/${abandoned.id}`, "valid-b", {
        method: "DELETE",
      });
      assert.equal(
        audioObjects.size,
        filesBefore,
        "abandoned upload audio cleaned up",
      );
      plan.sources[0].size++;
      assert.equal((await createUpload()).status, 400);
      // Real PDF/DOCX/XLSX fixtures are stored and shared but never sent to the AI.
      const documents = documentFixtures();
      const attachments = await Promise.all(documents.map(async (f: File) => ({
        id: crypto.randomUUID(),
        name: f.name,
        size: f.size,
        sha256: await attachmentDigest(await f.arrayBuffer()),
      })));
      const docCreate = await request("/uploads", "valid-a", {
        method: "POST",
        body: JSON.stringify({
          metadata: { title: "資料照合テスト", date: "2026-09-23" },
          sources: [{ name: "添付会議.wav", size: 44 }],
          parts: [
            {
              name: "recording-1-1.wav",
              size: 44,
              sourceIndex: 0,
              partNumber: 1,
              duration: 1,
            },
          ],
          attachments,
        }),
      });
      assert.equal(docCreate.status, 201, await docCreate.clone().text());
      const documentMeeting = await docCreate.json();
      const docRoute = `/meetings/${documentMeeting.id}`;
      assert.equal(documentMeeting.attachmentPlan, undefined);
      assert.equal(
        (
          await request(`${docRoute}/parts?index=0`, "valid-a", {
            method: "POST",
            body: new Blob([new Uint8Array(44)], { type: "audio/wav" }),
            headers: { "Content-Type": "audio/wav" },
          })
        ).status,
        200,
      );
      const uploadDocument = (file: File, id: string, token = "valid-a") => {
        const form = new FormData();
        form.set("attachment", file);
        form.set("id", id);
        return request(`${docRoute}/attachments`, token, {
          method: "POST",
          body: form,
        });
      };
      assert.equal(
        (await request(`${docRoute}/complete`, "valid-a", { method: "POST" }))
          .status,
        409,
      );
      assert.equal(
        (await uploadDocument(documents[0], attachments[0].id, "invalid"))
          .status,
        401,
      );
      const aiBefore = calls.length;
      const sameContentDifferentName = new File(
        [await documents[0].arrayBuffer()], "別名.pdf", { type: "application/pdf" });
      for (const [index, file] of documents.entries()) {
        const result = await uploadDocument(index === 0 ? sameContentDifferentName : file, attachments[index].id);
        assert.equal(result.status, 201, await result.clone().text());
        const saved = await result.json();
        assert.equal(saved.attachments[index].storagePath, undefined);
        assert.equal(saved.attachments[index].name, file.name);
        const path = rows.get(documentMeeting.id).document.attachments[index]
          .storagePath;
        const stored = audioObjects.get(
          `/storage/v1/object/kotonoha-documents/${path}`,
        )!;
        assert.deepEqual(
          new Uint8Array(await stored.arrayBuffer()),
          new Uint8Array(await file.arrayBuffer()),
        );
      }
      assert.equal(calls.length, aiBefore, "saving must not invoke AI");
      assert.equal(
        (await uploadDocument(documents[0], attachments[0].id)).status,
        409,
      );
      const sharedDocs = await (await request(docRoute, "valid-b")).json();
      assert.equal(sharedDocs.attachments.length, 3);
      assert.equal(
        (
          await request(
            `${docRoute}/attachments/${attachments[0].id}`,
            "invalid",
          )
        ).status,
        401,
      );
      assert.match(
        (
          await (
            await request(
              `${docRoute}/attachments/${attachments[0].id}`,
              "valid-b",
            )
          ).json()
        ).url,
        /signed/,
      );
      assert.equal(
        (await request(`${docRoute}/complete`, "valid-b", { method: "POST" }))
          .status,
        202,
      );
      await drain();
      await request("/meetings");
      await drain();
      assert.equal(
        (
          await uploadDocument(
            new File(["追加"], "note.txt"),
            crypto.randomUUID(),
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            `${docRoute}/attachments/${attachments[0].id}`,
            "valid-a",
            { method: "DELETE" },
          )
        ).status,
        409,
      );
      const responseInput = calls
        .filter((c) => c.route === "/v1/responses")
        .at(-1)!.body;
      assert.equal(typeof responseInput.input[1].content, "string");
      const sentText = JSON.stringify(responseInput);
      assert.ok(!sentText.includes("input_file"));
      assert.ok(!sentText.includes("kotonoha-documents"));
      for (const { name } of documents) assert.ok(!sentText.includes(name));
      assert.ok(
        !responseInput.text.format.schema.required.includes("documentReview"),
      );
      await request("/meetings");
      await drain();
      const finished = await (await request(docRoute, "valid-b")).json();
      assert.equal(finished.status, "done");
      assert.equal(finished.minutes.documentReview, undefined);
      assert.doesNotMatch(finished.markdown, /添付資料との照合/);
      assert.equal(finished.attachments.length, 3);
      const objectsBeforeUnlink = audioObjects.size;
      const detached = await request(
        `${docRoute}/attachments/${attachments[0].id}`,
        "valid-b",
        { method: "DELETE" },
      );
      assert.equal(detached.status, 200);
      const changed = await detached.json();
      assert.equal(changed.attachments.length, 2);
      assert.equal(changed.minutesStale, false);
      assert.equal(changed.removedAttachments, undefined);
      assert.equal(
        audioObjects.size,
        objectsBeforeUnlink,
        "unlink retains originals",
      );
      assert.equal(
        (await request(`${docRoute}/attachments/${attachments[0].id}`)).status,
        404,
      );
      const transcribedBefore = calls.filter((c) =>
        c.route.endsWith("/transcriptions"),
      ).length;
      const templateBefore = rows.get(documentMeeting.id).document.template;
      for (const body of ['{"template":"invalid"}', '{"template":null}', '{"template":"brief","status":"done"}', 'null']) {
        assert.equal((await request(`${docRoute}/retry`, "valid-b", { method: "POST", body })).status, 400);
        assert.equal(rows.get(documentMeeting.id).document.template, templateBefore);
      }
      assert.equal(
        (await request(`${docRoute}/retry`, "valid-b", { method: "POST", body: JSON.stringify({ template: "detailed" }) }))
          .status,
        202,
      );
      await drain();
      await request("/meetings");
      await drain();
      assert.equal(
        rows.get(documentMeeting.id).document.minutes.documentReview,
        undefined,
      );
      assert.equal(rows.get(documentMeeting.id).document.minutesStale, false);
      assert.equal(rows.get(documentMeeting.id).document.template, "detailed");
      const allFormats = await (await request(docRoute, "valid-b")).json();
      assert.deepEqual(Object.keys(allFormats.markdownByFormat), ["brief", "standard", "detailed"]);
      assert.equal(allFormats.markdown, allFormats.markdownByFormat.detailed);
      const aiCount = calls.filter(c => c.route === "/v1/responses").length;
      const usageCount = usageEvents.size;
      const editView = await request(docRoute, "valid-a", { method: "PATCH", body: JSON.stringify({ markdown: "# 要約だけ手動修正", markdownFormat: "brief" }) });
      assert.equal(editView.status, 200);
      const otherSession = await (await request(docRoute, "valid-b")).json();
      assert.equal(otherSession.markdownByFormat.brief, "# 要約だけ手動修正");
      assert.equal(otherSession.markdownByFormat.standard, allFormats.markdownByFormat.standard);
      assert.equal(otherSession.markdown, allFormats.markdown);
      assert.deepEqual(otherSession.minutes, allFormats.minutes);
      assert.equal(calls.filter(c => c.route === "/v1/responses").length, aiCount);
      assert.equal(usageEvents.size, usageCount);
      assert.equal((await request(docRoute, "valid-a", { method: "PATCH", body: JSON.stringify({ markdownFormat: "brief" }) })).status, 400);
      assert.match(calls.filter(c => c.route === "/v1/responses").at(-1)!.body.input[0].content, /背景、理由、異論も詳しく/);
      assert.equal(
        calls.filter((c) => c.route.endsWith("/transcriptions")).length,
        transcribedBefore,
      );
      const insightMeeting = { ...createDemo(), isDemo: false, source: "text", analysisId: crypto.randomUUID() };
      rows.set(insightMeeting.id, { owner, document: insightMeeting, audioPath: null, responseId: null });
      const postInsight = (body: any) => ({ method: "POST", body: JSON.stringify(body) });
      assert.equal((await request("/summary", "invalid", postInsight({ period: "month" }))).status, 401);
      assert.equal((await request("/summary", "valid-a", postInsight({ period: "year" }))).status, 400);
      const summary = await request("/summary", "valid-a", postInsight({ period: "month" }));
      assert.equal(summary.status, 200, await summary.clone().text());
      assert.match((await summary.json()).summary, /クラウド期間サマリー/);
      const suggested = await request("/suggest-tags", "valid-a", postInsight({ meetingId: insightMeeting.id }));
      assert.deepEqual((await suggested.json()).tags, ["共有", "進捗"]);
      assert.equal((await request("/suggest-tags", "valid-a", postInsight({ meetingId: "bad" }))).status, 400);
      const tagPatch = await request(`/meetings/${insightMeeting.id}`, "valid-a", { method: "PATCH", body: JSON.stringify({ tags: ["共有"] }) });
      assert.equal(tagPatch.status, 200);
      assert.deepEqual((await (await request(`/meetings/${insightMeeting.id}`, "valid-b")).json()).tags, ["共有"]);
      assert.ok([...usageEvents.values()].some((e) => e.operation === "summary" && e.costUsd > 0));
      assert.ok([...usageEvents.values()].some((e) => e.operation === "tags" && e.meetingId === insightMeeting.id));
      const tagUsage = [...usageEvents.values()].find(e => e.operation === "tags" && e.meetingId === insightMeeting.id);
      assert.equal(tagUsage.parentRunId, insightMeeting.analysisId);
      assert.equal(tagUsage.runId, insightMeeting.analysisId);
      const rangeModule = await import("../supabase/functions/_shared/insights.mjs");
      const prior = rangeModule.summaryRange("lastMonth");
      const historical = { ...insightMeeting, id: crypto.randomUUID(), date: prior.end };
      rows.set(historical.id, { owner, document: historical, audioPath: null, responseId: null });
      const previous = await request("/summary", "valid-a", postInsight({ period: "lastMonth" }));
      assert.equal(previous.status, 200);
      const previousData = await previous.json();
      assert.equal(previousData.start, prior.start);
      assert.equal(previousData.end, prior.end);
      assert.ok(previousData.meetingCount >= 1);
      const custom = await request("/summary", "valid-a", postInsight({ period: "custom", start: prior.end, end: prior.end }));
      assert.equal(custom.status, 200);
      const customData = await custom.json();
      assert.equal(customData.start, prior.end);
      assert.equal(customData.end, prior.end);
      assert.ok(customData.meetingCount >= 1);
      for (const body of [{ period: "custom" }, { period: "custom", start: "2026-02-30", end: "2026-03-01" }, { period: "custom", start: "2026-03-01", end: "2026-02-28" }, { period: "custom", start: "9999-01-01", end: "9999-01-02" }]) {
        assert.equal((await request("/summary", "valid-a", postInsight(body))).status, 400);
      }
      assert.equal(
        (await request("/auth/logout", loginSession.token, { method: "POST" }))
          .status,
        204,
      );
      assert.equal(
        (await request("/meetings", loginSession.token)).status,
        401,
      );
      assert.equal((await request("/meetings", "valid-a")).status, 200);
      assert.equal((await request("/meetings", "valid-b")).status, 200);
    } finally {
      await drain();
      globalThis.fetch = realFetch;
      Date.now = realNow;
    }
  },
);
