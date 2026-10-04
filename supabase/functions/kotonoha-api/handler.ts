import { createClient } from "@supabase/supabase-js";
import { googleAuthRoute } from "../_shared/kotonoha-google-auth.ts";
import { z } from "zod";
import { meetingDuration } from "../_shared/duration.mjs";
import {
  calendarChange,
  calendarHide,
  calendarRestore,
} from "../_shared/calendar.mjs";
import { usageEvent } from "../_shared/usage.mjs";
import { SummaryRequest, TagsRequest, periodMeetings, insightRequest, parseInsight } from "../_shared/insights.mjs";
import {
  MAX_FILE_SIZE,
  MAX_TEXT_LENGTH,
  MetadataSchema,
  RetrySchema,
  minutesToMarkdown,
  PatchSchema,
  renameMarkdownHeading,
  safeError,
} from "../_shared/domain.mjs";
import { createDemo } from "../_shared/demo.mjs";
import {
  attachmentExtension,
  attachmentDigest,
  attachmentTypes,
  checkAttachmentAdd,
  MAX_ATTACHMENT_SIZE,
  publicAttachments,
  validateAttachmentBytes,
} from "../_shared/attachments.mjs";
import {
  CalendarMinutesSchema,
  parseMinutes,
  summaryInput,
} from "../_shared/summary.mjs";
import {
  MAX_BATCH_SIZE,
  uploadDocument,
  uploadPart,
  UploadSchema,
} from "../_shared/upload.mjs";
import {
  needsTranscription,
  prepareAudio,
  publicRecordings,
  recordingsFor,
  partOffset,
  transcribeRecordings,
  validateRecordings,
} from "../_shared/audio.mjs";
import { decryptApiKey, encryptApiKey } from "../_shared/key-crypto.mjs";
import {
  GEMINI_TRANSCRIPTION_MODEL,
  transcribeWithGemini,
} from "../_shared/gemini-transcribe.mjs";
import { geminiRetryPlan, geminiRetryError } from "../_shared/gemini-retry.mjs";
import {
  createToken,
  hashToken,
  validTokenFormat,
} from "../_shared/session.mjs";
import {
  MAX_TICK_MEETINGS,
  MIN_TICK_SECRET_LENGTH,
  TICK_HEADER,
  tickCandidates,
  verifyTickSecret,
} from "../_shared/tick.mjs";
import {
  BotRequestSchema,
  BotStatusSchema,
  BotUploadSchema,
  botDocument,
  botView,
  createUploadToken,
  uploadTokenFrom,
  WEBHOOK_SECRET_HEADER,
  WEBHOOK_TIMEOUT_MS,
  webhookPayload,
} from "../_shared/bot.mjs";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };
type Doc = Record<string, any>;
type RecordRow = {
  document: Doc;
  audioPath: string | null;
  responseId: string | null;
  leaseUntil: string | null;
  updatedAt: string;
};
const BUCKET = "kotonoha-audio";
const DOCUMENT_BUCKET = "kotonoha-documents";
const ORIGINS = new Set([
  "https://marugo-s.github.io",
  "http://127.0.0.1:5188",
  "http://localhost:5188",
  "http://127.0.0.1:5189",
  "http://127.0.0.1:4318",
]);
const service = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const encryptionSecret = Deno.env.get("KOTONOHA_KEY_ENCRYPTION_SECRET") || "";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe";
const settingsSchema = z
  .object({
    model: z.enum(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]),
    transcriptionModel: z
      .enum([OPENAI_TRANSCRIPTION_MODEL, GEMINI_TRANSCRIPTION_MODEL])
      .default(OPENAI_TRANSCRIPTION_MODEL),
    apiKey: z.string().trim().min(20).max(500).optional(),
    geminiApiKey: z.string().trim().min(20).max(500).optional(),
  })
  .strict();
const working = (doc: Doc) =>
  ["transcribing", "analyzing"].includes(doc.status);
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status, publicMessage: message });

async function store(
  operation: string,
  owner: string,
  id: string | null = null,
  payload: Doc = {},
  rpc = "kotonoha_store",
): Promise<any> {
  const { data, error } = await service.rpc(rpc, {
    p_operation: operation,
    p_owner: owner,
    p_id: id,
    p_payload: payload,
  });
  if (error) {
    if (error.message.includes("CALENDAR_LIMIT")) {
      throw fail(400, "1会議の手動予定は200件までです。");
    }
    if (error.message.includes("ATTACHMENT_LIMIT")) {
      throw fail(
        400,
        "添付資料は最大5ファイル、1ファイル10 MB、合計25 MBまでです。",
      );
    }
    if (error.message.includes("ATTACHMENT_")) {
      throw fail(
        409,
        "資料を保存できませんでした。会議を更新し、選択した資料を確認してください。",
      );
    }
    if (error.message.includes("UPLOAD_LIMIT")) {
      throw fail(
        429,
        "取り込み途中の会議があります。削除してから再度取り込んでください。",
      );
    }
    if (error.message.includes("UPLOAD_")) {
      throw fail(
        409,
        "音声・添付資料の取り込みが未完了、または順序が不正です。",
      );
    }
    if (error.message.includes("BOT_LIMIT")) {
      throw fail(
        429,
        "Botの参加待ちの会議が多すぎます。不要な会議を削除してから再度お試しください。",
      );
    }
    if (error.message.includes("BOT_CLOSED")) {
      throw fail(409, "この会議はBotの録音を受け付けていません。");
    }
    if (error.message.includes("NOT_FOUND")) {
      throw fail(404, "会議が見つかりません。");
    }
    if (error.message.includes("BUSY")) {
      throw fail(409, "会議を処理中です。完了後にもう一度操作してください。");
    }
    if (error.message.includes("CONCURRENCY_LIMIT")) {
      throw fail(429, "同時に処理できる会議は2件までです。");
    }
    if (error.message.includes("MEETING_LIMIT")) {
      throw fail(
        400,
        "保存できる会議は1,000件までです。不要な会議を整理してください。",
      );
    }
    throw fail(
      503,
      "会議データに接続できませんでした。しばらくしてから再試行してください。",
    );
  }
  return data;
}
function expose(record: RecordRow) {
  const {
    runId: _runId,
    analysisId: _analysisId,
    audioFile: _audioFile,
    audioParts: _audioParts,
    uploadPlan: _uploadPlan,
    partReady: _partReady,
    attachments: _attachments,
    attachmentPlan: _attachmentPlan,
    removedAttachments: _removedAttachments,
    ...doc
  } = record.document;
  const recordings = publicRecordings(
    recordingsFor(record.document, record.audioPath),
  );
  return {
    ...doc,
    duration: meetingDuration(record.document),
    hasAudio: recordings.length > 0,
    recordings,
    attachments: publicAttachments(record.document),
  };
}
function exposeSettings(config: Doc) {
  return {
    configured: Boolean(config.encryptedKey && encryptionSecret),
    geminiConfigured: Boolean(config.encryptedGeminiKey && encryptionSecret),
    model: config.model,
    transcriptionModel: config.transcriptionModel || OPENAI_TRANSCRIPTION_MODEL,
    maxFileSize: MAX_BATCH_SIZE,
    cloud: true,
  };
}
async function getKey(
  owner: string,
  config: Doc,
  provider: "openai" | "gemini",
): Promise<string> {
  const encrypted =
    provider === "gemini" ? config.encryptedGeminiKey : config.encryptedKey;
  if (!encrypted) {
    throw fail(
      428,
      `接続設定で${
        provider === "gemini" ? "Gemini" : "OpenAI"
      } APIキーを設定してください。`,
    );
  }
  if (!encryptionSecret) {
    throw fail(
      503,
      "APIキー保存機能の初期設定が完了していません。管理者にご連絡ください。",
    );
  }
  try {
    return await decryptApiKey(encrypted, owner, encryptionSecret);
  } catch {
    throw fail(
      428,
      `${
        provider === "gemini" ? "Gemini" : "OpenAI"
      } APIキーを読み取れませんでした。接続設定から再入力してください。`,
    );
  }
}
async function getKeys(
  owner: string,
  config: Doc,
  transcriptionModel?: string | null,
) {
  const openaiKey = await getKey(owner, config, "openai");
  return {
    openai: openaiKey,
    ...(transcriptionModel === GEMINI_TRANSCRIPTION_MODEL
      ? { gemini: await getKey(owner, config, "gemini") }
      : {}),
  };
}
async function bodyBytes(req: Request, limit: number) {
  if (Number(req.headers.get("content-length") || 0) > limit) {
    throw fail(413, "ファイルまたはテキストが大きすぎます。");
  }
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw fail(
        413,
        "送信データが上限を超えています。資料は1ファイル10 MBまでです。音声は画面から自動分割して送信してください。",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function jsonBody(req: Request, allowEmpty = false) {
  try {
    const text = new TextDecoder().decode(await bodyBytes(req, 1_000_000));
    return allowEmpty && text === "" ? {} : JSON.parse(text);
  } catch (error) {
    if ((error as any).publicMessage) throw error;
    throw fail(400, "入力形式を確認してください。");
  }
}
async function openai(
  key: string,
  route: string,
  init: RequestInit = {},
  timeout = 25_000,
) {
  const response = await fetch(`https://api.openai.com/v1${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    throw Object.assign(new Error("OpenAI request failed"), {
      status: response.status,
    });
  }
  return await response.json();
}
async function usageId(providerId?: string) {
  if (!providerId) return crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(providerId),
  ));
  digest[6] = (digest[6] & 15) | 80;
  digest[8] = (digest[8] & 63) | 128;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function recordApiUsage(
  owner: string, meeting: Doc, kind: "transcription" | "minutes",
  model: string, response: Doc, duration?: number | null, operation?: string, parentRunId?: string,
) {
  try {
    const id = await usageId(response?.id ? `${owner}:${kind}:${response.id}` : undefined);
    await store("record", owner, null, usageEvent({
      id, meetingId: meeting.id, meetingTitle: meeting.title,
      runId: meeting.analysisId,
      kind, model, response, audioSeconds: duration, operation, parentRunId,
    }), "kotonoha_usage");
  } catch (error) {
    console.error("kotonoha API usage could not be saved", (error as any)?.status || "unknown");
  }
}
async function jobUpdate(
  owner: string,
  record: RecordRow,
  patch: Doc,
  responseId?: string | null,
): Promise<RecordRow> {
  return store("job_update", owner, record.document.id, {
    runId: record.document.runId,
    patch,
    ...(responseId === undefined ? {} : { responseId }),
  });
}
async function finalize(
  owner: string,
  record: RecordRow,
  result: Doc,
): Promise<RecordRow> {
  if (["completed", "failed", "cancelled", "incomplete"].includes(result.status)) {
    await recordApiUsage(owner, record.document, "minutes", record.document.minutesModel, result);
  }
  if (result.status === "completed") {
    const output = (result.output || []).flatMap((item: Doc) =>
      item.type === "message" ? item.content || [] : [],
    );
    const text = output
      .filter((item: Doc) => item.type === "output_text")
      .map((item: Doc) => item.text)
      .join("");
    let minutes;
    try {
      minutes = parseMinutes(record.document, JSON.parse(text));
    } catch {
      return jobUpdate(owner, record, {
        status: "error",
        error:
          "議事録の形式を確認できませんでした。文字起こしを確認して再試行してください。",
      });
    }
    return jobUpdate(owner, record, {
      status: "done",
      minutes,
      markdown: minutesToMarkdown(record.document, minutes),
      completedActions: [],
      error: null,
      minutesStale: false,
    });
  }
  if (["failed", "cancelled", "incomplete"].includes(result.status)) {
    return jobUpdate(owner, record, {
      status: "error",
      error:
        "AIが議事録を完成できませんでした。文字起こしは保存されています。内容を確認して再試行してください。",
    });
  }
  return record;
}
async function startSummary(owner: string, record: RecordRow, key: string) {
  const m = record.document;
  if (m.transcript.length > MAX_TEXT_LENGTH) {
    throw Object.assign(new Error("too long"), { code: "TEXT_TOO_LONG" });
  }
  const { $schema: _, ...outputSchema } = z.toJSONSchema(CalendarMinutesSchema);
  const result = await openai(key, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model: m.minutesModel,
      reasoning: { effort: "medium" },
      max_output_tokens: 16000,
      background: true,
      store: true,
      input: summaryInput(m),
      text: {
        format: {
          type: "json_schema",
          name: "meeting_minutes",
          strict: true,
          schema: outputSchema,
        },
      },
    }),
  });
  if (!result.id) throw new Error("Missing response id");
  const saved = await jobUpdate(
    owner,
    record,
    { status: "analyzing" },
    result.id,
  );
  return finalize(owner, saved, result);
}
async function processMeeting(
  owner: string,
  initial: RecordRow,
  keys: { openai: string; gemini?: string },
) {
  let record = initial;
  const gateRunId = initial.document.runId;
  const gemini =
    record.document.transcriptionModel === GEMINI_TRANSCRIPTION_MODEL;
  let heldGeminiSlot = false;
  let cooldown: Doc = {};
  const gate = (operation: string, extra: Doc = {}) =>
    store(
      operation,
      owner,
      record.document.id,
      { runId: gateRunId, ...extra },
      "kotonoha_gemini_gate",
    );
  try {
    if (
      needsTranscription(record.document, record.audioPath) ||
      !record.document.transcript
    ) {
      // One part runs per invocation; a part Gemini could not finish goes to OpenAI.
      const pending = recordingsFor(record.document, record.audioPath).find(
        (part: Doc) => !part.transcript,
      );
      if (gemini && !pending?.transcriptionFallback) {
        const slot = await gate("reserve");
        if (!slot) return; // Superseded job: do not send an obsolete request.
        if (!slot.allowed) {
          await jobUpdate(owner, record, {
            partReady: true,
            transcriptionWait: {
              until: slot.until,
              reason: slot.reason,
              attempt: record.document.geminiRetryCount || 0,
            },
          });
          return;
        }
        heldGeminiSlot = true;
        record = await jobUpdate(owner, record, {
          transcriptionWait: null,
          diagnosticCode: null,
        });
      }
      const transcript = await transcribeRecordings(
        recordingsFor(record.document, record.audioPath),
        async (part: Doc, index: number) => {
          if (!part.audioPath) throw new Error("No audio");
          const { data, error } = await service.storage
            .from(BUCKET)
            .download(part.audioPath);
          if (error || !data) throw new Error("Audio unavailable");
          const fileName = part.audioPath.split("/").pop() || "meeting.mp3";
          const previous = record.document.audioParts?.[index - 1]?.transcript;
          const duration = part.duration || (recordingsFor(record.document, record.audioPath).length === 1
            ? record.document.duration : null);
          if (
            record.document.transcriptionModel === GEMINI_TRANSCRIPTION_MODEL &&
            !part.transcriptionFallback
          ) {
            if (!keys.gemini) {
              throw fail(428, "接続設定でGemini APIキーを設定してください。");
            }
            return transcribeWithGemini(keys.gemini, data, fileName,
              (response: Doc) => recordApiUsage(owner, record.document,
                "transcription", GEMINI_TRANSCRIPTION_MODEL, response, duration),
              { offset: partOffset(recordingsFor(record.document, record.audioPath), index) });
          }
          const form = new FormData();
          // The display name may be .aac, while storage contains a remuxed .m4a.
          form.set("file", data, fileName);
          form.set("model", OPENAI_TRANSCRIPTION_MODEL);
          form.set("response_format", "json");
          form.append("languages[]", "ja");
          if (record.document.chunked && previous) {
            form.set("prompt", previous.slice(-1200));
          }
          const result = await openai(
            keys.openai,
            "/audio/transcriptions",
            { method: "POST", body: form },
            110_000,
          );
          await recordApiUsage(owner, record.document, "transcription",
            OPENAI_TRANSCRIPTION_MODEL, result, duration);
          return result.text;
        },
        async (audioParts: Doc[]) => {
          record = await jobUpdate(owner, record, {
            audioParts,
            geminiRetryCount: 0,
            transcriptionWait: null,
          });
        },
        record.document.chunked || gemini ? 1 : Infinity,
      );
      if (record.document.chunked || gemini) {
        await jobUpdate(owner, record, {
          partReady: true,
          ...(transcript !== null
            ? { transcript, status: "analyzing", segments: [] }
            : {}),
        });
        return;
      }
      record = await jobUpdate(owner, record, {
        transcript,
        status: "analyzing",
        segments: [],
        transcriptionModel:
          record.document.transcriptionModel || OPENAI_TRANSCRIPTION_MODEL,
      });
    }
    await startSummary(owner, record, keys.openai);
  } catch (error) {
    const cause = (error as any).cause || error;
    const partIndex = (error as any).partIndex;
    const failedPart = record.document.audioParts?.[partIndex];
    if (
      cause?.code === "GEMINI_TRANSCRIPT_INCOMPLETE" &&
      failedPart &&
      !failedPart.transcriptionFallback
    ) {
      // Retry only this part with GPT Transcribe in the next invocation, so the
      // Gemini and OpenAI calls never share one Edge Function time budget.
      const geminiStatus = cause.geminiStatus || "unknown";
      await jobUpdate(owner, record, {
        audioParts: record.document.audioParts.map((part: Doc, i: number) =>
          i === partIndex
            ? {
                ...part,
                transcriptionFallback: {
                  model: OPENAI_TRANSCRIPTION_MODEL,
                  geminiStatus,
                },
              }
            : part,
        ),
        partReady: true,
        transcriptionWait: null,
        diagnosticCode: `GEMINI_FALLBACK_${geminiStatus.toUpperCase()}`,
      });
      return;
    }
    const retry = heldGeminiSlot
      ? geminiRetryPlan(cause, record.document.geminiRetryCount || 0)
      : null;
    if (retry && !retry.stop) {
      cooldown = { delayMs: retry.delayMs, reason: "rate_limit" };
      const slot = await gate("finish", cooldown);
      heldGeminiSlot = false;
      await jobUpdate(owner, record, {
        status: "transcribing",
        error: null,
        partReady: true,
        diagnosticCode: "GEMINI_RATE_LIMIT_WAIT",
        geminiRetryCount: retry.attempt,
        transcriptionWait: {
          until: slot?.until || retry.until,
          reason: "rate_limit",
          attempt: retry.attempt,
        },
      });
      return;
    }
    if (retry?.stop) error = geminiRetryError(retry.stop);
    const message =
      (error as Error).name === "TimeoutError"
        ? "音声の処理が時間内に完了しませんでした。長い録音は分割して取り込んでください。"
        : (error as any).publicMessage || safeError(error);
    await jobUpdate(owner, record, {
      status: "error",
      error: message,
      transcriptionWait: null,
      diagnosticCode: String(
        (error as any).diagnosticCode || (error as any).code || "UNKNOWN",
      ).slice(0, 100),
    });
    console.error(
      "kotonoha job failed",
      (error as Error).name,
      (error as any).status || "",
    );
  } finally {
    if (heldGeminiSlot)
      await gate("finish", cooldown).catch(() =>
        console.error("kotonoha Gemini gate release failed"),
      );
  }
}
async function reconcile(
  owner: string,
  record: RecordRow,
  keys: { openai: string; gemini?: string } | null,
): Promise<RecordRow> {
  if (!working(record.document)) return record;
  // Durable waits must be checked before lease expiry: no Edge Function sleeps.
  if (Date.parse(record.document.transcriptionWait?.until || "") > Date.now())
    return record;
  if (
    (record.document.chunked ||
      record.document.transcriptionModel === GEMINI_TRANSCRIPTION_MODEL) &&
    record.document.partReady &&
    keys
  ) {
    const next = await store(
      "next",
      owner,
      record.document.id,
      { runId: crypto.randomUUID() },
      "kotonoha_audio_upload",
    );
    if (next) {
      EdgeRuntime.waitUntil(
        processMeeting(owner, next, keys).catch(() =>
          console.error("kotonoha persistence failure"),
        ),
      );
    }
    return next || record;
  }
  if (record.responseId && keys) {
    let result: Doc;
    try {
      result = await openai(
        keys.openai,
        `/responses/${encodeURIComponent(record.responseId)}`,
      );
    } catch (error) {
      if ((error as any).status === 404) {
        return jobUpdate(owner, record, {
          status: "error",
          error:
            "AIの結果保存期間が終了したか、参照できません。保存済みの文字起こしから再生成してください。",
        });
      }
      throw error;
    }
    const finalized = await finalize(owner, record, result);
    if (
      working(finalized.document) &&
      Date.parse(record.leaseUntil || "") < Date.now()
    ) {
      return jobUpdate(owner, record, {}, record.responseId);
    }
    return finalized;
  }
  if (Date.parse(record.leaseUntil || "") < Date.now()) {
    return jobUpdate(owner, record, {
      status: "error",
      error: "処理が中断されました。保存済みの内容から再試行できます。",
    });
  }
  return record;
}

// Advance every working meeting one step: claim and start the next audio part, resume after a
// Gemini wait, collect a background minutes result, or mark an abandoned lease as interrupted.
// Used by GET /meetings (open clients) and POST /internal/tick (scheduled, no client needed).
// Claims go through the `next` RPC (advisory lock + partReady flag + 2-job limit) and job updates
// are guarded by runId, so concurrent callers never process the same part twice.
async function advanceMeetings(
  owner: string,
  config: Doc,
  records: RecordRow[],
  isolate = false,
): Promise<RecordRow[]> {
  const active = records.filter(
    (r) => working(r.document) && (r.responseId || r.document.partReady),
  );
  const keys = active.length
    ? await getKeys(
        owner,
        config,
        active.some(
          (r) =>
            !r.responseId &&
            r.document.transcriptionModel === GEMINI_TRANSCRIPTION_MODEL,
        )
          ? GEMINI_TRANSCRIPTION_MODEL
          : null,
      )
    : null;
  if (!isolate)
    return Promise.all(records.map((record) => reconcile(owner, record, keys)));
  // Scheduled ticks: one meeting's transient failure (e.g. OpenAI 5xx) must not block others;
  // it is retried on the next tick exactly like a failed list refresh.
  const settled = await Promise.allSettled(
    records.map((record) => reconcile(owner, record, keys)),
  );
  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    console.error("kotonoha tick reconcile failed", (result.reason as any)?.status || "");
    return records[i];
  });
}
async function runTick() {
  // The shared workspace id lives in kotonoha.access_config; only service_role may read it.
  const { data: workspace, error } = await service.rpc("kotonoha_tick", {
    p_operation: "workspace",
  });
  if (error) {
    throw fail(503, "Tick is not configured. Apply the kotonoha tick migration.");
  }
  const owner = workspace?.workspaceId;
  if (!owner) return { meetings: 0, advanced: 0 };
  const records: RecordRow[] = await store("list", owner);
  const candidates = tickCandidates(records, MAX_TICK_MEETINGS) as RecordRow[];
  if (!candidates.length) return { meetings: 0, advanced: 0 };
  const config = await store("get", owner, null, {}, "kotonoha_settings");
  let resolved: RecordRow[];
  try {
    resolved = await advanceMeetings(owner, config, candidates, true);
  } catch (error) {
    // Missing keys: nothing can progress until settings are fixed; report without detail.
    if ((error as any).status === 428) return { meetings: candidates.length, advanced: 0, waiting: "KEYS" };
    throw error;
  }
  const advanced = resolved.filter((r, i) =>
    r.document.runId !== candidates[i].document.runId ||
    r.document.status !== candidates[i].document.status ||
    r.responseId !== candidates[i].responseId
  ).length;
  return { meetings: candidates.length, advanced };
}

// Chunked upload steps shared by the logged-in routes (/meetings/:id/...) and the bot routes
// (/bot/meetings/:id/..., upload-token auth). Both go through the same RPCs and checks.
async function appendPart(
  req: Request,
  owner: string,
  id: string,
  record: RecordRow,
): Promise<RecordRow> {
  const index = Number(new URL(req.url).searchParams.get("index"));
  let expected;
  try {
    expected = uploadPart(record.document, index);
  } catch (error) {
    throw fail(409, (error as Error).message);
  }
  const bytes = await bodyBytes(req, expected.size);
  if (bytes.length !== expected.size) {
    throw fail(400, "録音のサイズが一致しません。");
  }
  const partPath = `${owner}/${id}/${crypto.randomUUID()}-${expected.name}`;
  const ext = expected.name.split(".").pop();
  const mime = (
    {
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      flac: "audio/flac",
    } as Record<string, string>
  )[ext];
  const { error } = await service.storage
    .from(BUCKET)
    .upload(partPath, new Blob([bytes], { type: mime }), {
      contentType: mime,
      upsert: false,
    });
  if (error) {
    throw fail(503, "音声を保存できませんでした。再度取り込んでください。");
  }
  try {
    return await store(
      "append",
      owner,
      id,
      { index, part: { ...expected, audioPath: partPath, transcript: "" } },
      "kotonoha_audio_upload",
    );
  } catch (error) {
    // A network error may mean the append committed but its response was
    // lost. Do not destroy a potentially registered recording in that case.
    if ([404, 409].includes((error as any).status)) {
      await service.storage.from(BUCKET).remove([partPath]);
    }
    throw error;
  }
}
async function completeUpload(
  owner: string,
  id: string,
  config: Doc,
  record: RecordRow,
): Promise<RecordRow> {
  const keys = await getKeys(
    owner,
    config,
    record.document.transcriptionModel,
  );
  const claimed = await store(
    "complete",
    owner,
    id,
    { runId: crypto.randomUUID() },
    "kotonoha_attachments",
  );
  return reconcile(owner, claimed, keys);
}

const apiBaseUrl = () =>
  (
    Deno.env.get("MEETBOT_API_BASE_URL") ||
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/kotonoha-api`
  ).replace(/\/$/, "");
async function sendBotWebhook(url: string, secret: string, payload: Doc, authorization = "") {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { [WEBHOOK_SECRET_HEADER]: secret } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    throw fail(502, "Botに接続できませんでした。Botの稼働状況を確認して再度お試しください。");
  }
  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    throw fail(
      502,
      `Botが依頼を受け付けませんでした（HTTP ${response.status}）。しばらくしてから再度お試しください。`,
    );
  }
}
// Upload-token routes used by the Meet bot. The token only works for its own meeting and only
// for status / upload plan / parts / complete; it is never a login session.
async function handleBotRoute(
  req: Request,
  route: string,
  json: (value: unknown, status?: number) => Response,
) {
  const match = route.match(
    /^\/bot\/meetings\/([a-f0-9-]{36})(?:\/(status|uploads|parts|complete))?$/,
  );
  if (!match) throw fail(404, "指定された機能が見つかりません。");
  const token = uploadTokenFrom(req.headers);
  if (!token) return json({ error: "アップロードトークンが必要です。" }, 401);
  const { data: grant, error } = await service.rpc("kotonoha_bot", {
    p_operation: "auth",
    p_payload: { tokenHash: await hashToken(token) },
  });
  if (error) {
    return json(
      { error: "トークンを確認できません。しばらくしてから再試行してください。" },
      503,
    );
  }
  if (!grant?.workspaceId || grant.error) {
    return json(
      { error: "アップロードトークンが無効か、有効期限が切れています。" },
      401,
    );
  }
  const id = z.uuid().parse(match[1]);
  if (grant.meetingId !== id) {
    return json({ error: "このトークンでは操作できない会議です。" }, 403);
  }
  const owner: string = grant.workspaceId;
  let record: RecordRow = await store("get", owner, id);
  const brief = (r: RecordRow) => ({
    id,
    status: r.document.status,
    uploadedParts: r.document.audioParts?.length || 0,
    plannedParts: r.document.uploadPlan?.length || 0,
    bot: botView(r.document),
  });
  if (!match[2] && req.method === "GET") return json(brief(record));
  if (req.method !== "POST") throw fail(405, "この操作には対応していません。");
  if (match[2] === "status") {
    const input = BotStatusSchema.parse(await jsonBody(req));
    record = await store(
      "status",
      owner,
      id,
      { state: input.state, message: input.message || null },
      "kotonoha_bot",
    );
    return json(brief(record));
  }
  const config = await store("get", owner, null, {}, "kotonoha_settings");
  if (match[2] === "uploads") {
    const body = BotUploadSchema.parse(await jsonBody(req));
    const d = record.document;
    const input = UploadSchema.parse({
      ...body,
      // Title, date, participants and depth are what the user entered when calling the bot.
      metadata: { title: d.title, date: d.date, participants: d.participants || "", template: d.template },
      transcript: "",
      attachments: [],
    });
    await getKeys(owner, config, d.transcriptionModel || config.transcriptionModel);
    const document = uploadDocument(
      input,
      id,
      d.minutesModel || config.model,
      d.transcriptionModel || config.transcriptionModel,
    );
    record = await store(
      "plan",
      owner,
      id,
      { document: { ...document, analysisId: crypto.randomUUID() } },
      "kotonoha_bot",
    );
    return json(brief(record), 201);
  }
  if (match[2] === "parts") {
    return json(brief(await appendPart(req, owner, id, record)));
  }
  // complete: same claim + first reconcile as POST /meetings/:id/complete, then revoke the token.
  record = await completeUpload(owner, id, config, record);
  try {
    await store("revoke", owner, id, {}, "kotonoha_bot");
  } catch {
    // The meeting has left 'uploading', which already makes the token unusable.
    console.error("kotonoha bot token revoke failed");
  }
  return json(brief(record), 202);
}

export async function handler(req: Request) {
  const origin = req.headers.get("origin");
  const cors: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-kotonoha, x-client-info, x-upload-token",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    Vary: "Origin",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && ORIGINS.has(origin)) {
    cors["Access-Control-Allow-Origin"] = origin;
  }
  const json = (value: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(value), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  if (origin && !ORIGINS.has(origin)) {
    return json({ error: "アクセス元が許可されていません。" }, 403);
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  try {
    const pathname = new URL(req.url).pathname;
    const route =
      pathname.slice(
        pathname.indexOf("/kotonoha-api") + "/kotonoha-api".length,
      ) || "/";
    if (route === "/internal/tick") {
      // Server-to-server only (pg_cron + pg_net). Never reachable with a user session.
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const expected = Deno.env.get("KOTONOHA_TICK_SECRET") || "";
      if (!(await verifyTickSecret(req.headers.get(TICK_HEADER), expected))) {
        return json(
          { error: "Unauthorized" },
          expected.length >= MIN_TICK_SECRET_LENGTH ? 401 : 503,
        );
      }
      return json(await runTick());
    }
    if (route.startsWith("/bot/meetings/")) {
      return await handleBotRoute(req, route, json);
    }
    if (route.startsWith("/auth/google/")) {
      return json(await googleAuthRoute(req, route, (name,args) => service.rpc(name,args)));
    }
    if (route === "/auth/login" && req.method === "POST") {
      const input = z
        .object({
          loginId: z.string().trim().min(1).max(100),
          password: z
            .string()
            .min(1)
            .max(72)
            .refine((value) => new TextEncoder().encode(value).length <= 72),
        })
        .strict()
        .parse(
          JSON.parse(new TextDecoder().decode(await bodyBytes(req, 4096))),
        );
      const token = createToken();
      const ip =
        req.headers.get("cf-connecting-ip") ||
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown";
      const { data, error } = await service.rpc("kotonoha_auth", {
        p_operation: "login",
        p_payload: {
          ...input,
          tokenHash: await hashToken(token),
          ipHash: await hashToken(`kotonoha-login:${ip}`),
        },
      });
      if (error || !data || data.error === "NOT_CONFIGURED") {
        return json(
          {
            error:
              "ログイン機能の設定が完了していません。管理者にご連絡ください。",
          },
          503,
        );
      }
      if (data.error === "RATE_LIMIT") {
        return json(
          {
            error:
              "ログインの試行回数が上限に達しました。15分ほど待ってから再試行してください。",
          },
          429,
        );
      }
      if (data.error) {
        return json({ error: "IDまたはパスワードが正しくありません。" }, 401);
      }
      return json({ token, expiresAt: data.expiresAt });
    }
    const token = req.headers
      .get("Authorization")
      ?.match(/^Bearer (.+)$/i)?.[1];
    if (!validTokenFormat(token)) {
      return json({ error: "ログインが必要です。" }, 401);
    }
    const tokenHash = await hashToken(token!);
    const { data: session, error: authError } = await service.rpc(
      "kotonoha_auth",
      {
        p_operation: "session",
        p_payload: { tokenHash },
      },
    );
    if (authError) {
      return json(
        {
          error:
            "ログイン情報を確認できません。しばらくしてから再試行してください。",
        },
        503,
      );
    }
    if (!session?.workspaceId || session.error) {
      return json(
        {
          error: "ログインの有効期限が切れています。再度ログインしてください。",
        },
        401,
      );
    }
    if (route === "/auth/session" && req.method === "GET") {
      return json({ expiresAt: session.expiresAt });
    }
    if (route === "/auth/logout" && req.method === "POST") {
      const { error } = await service.rpc("kotonoha_auth", {
        p_operation: "logout",
        p_payload: { tokenHash },
      });
      if (error) {
        return json(
          { error: "ログアウトできませんでした。もう一度お試しください。" },
          503,
        );
      }
      return json(null, 204);
    }
    const owner = session.workspaceId;
    const config = await store("get", owner, null, {}, "kotonoha_settings");
    if (route === "/settings" && req.method === "GET") {
      return json(exposeSettings(config));
    }
    if (route === "/usage" && req.method === "GET") {
      const query = new URL(req.url).searchParams;
      const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).parse(query.get("month"));
      const page = z.coerce.number().int().min(0).max(100000).parse(query.get("page") || "0");
      return json(await store("list", owner, null, { month, page }, "kotonoha_usage"));
    }
    if (route === "/settings" && req.method === "PUT") {
      const input = settingsSchema.parse(await jsonBody(req));
      if ((input.apiKey || input.geminiApiKey) && !encryptionSecret) {
        throw fail(503, "APIキー保存機能の初期設定が完了していません。");
      }
      if (
        input.transcriptionModel === GEMINI_TRANSCRIPTION_MODEL &&
        !input.geminiApiKey &&
        !config.encryptedGeminiKey
      ) {
        throw fail(428, "Gemini APIキーを入力してください。");
      }
      const saved = await store(
        "put",
        owner,
        null,
        {
          model: input.model,
          transcriptionModel: input.transcriptionModel,
          ...(input.apiKey
            ? {
                encryptedKey: await encryptApiKey(
                  input.apiKey,
                  owner,
                  encryptionSecret,
                ),
              }
            : {}),
          ...(input.geminiApiKey
            ? {
                encryptedGeminiKey: await encryptApiKey(
                  input.geminiApiKey,
                  owner,
                  encryptionSecret,
                ),
              }
            : {}),
        },
        "kotonoha_settings",
      );
      return json(exposeSettings(saved));
    }
    if (route === "/meetings" && req.method === "GET") {
      const records: RecordRow[] = await store("list", owner);
      return json((await advanceMeetings(owner, config, records)).map(expose));
    }
    if (route === "/demo" && req.method === "POST") {
      const demo = createDemo();
      return json(
        expose(await store("create", owner, demo.id, { document: demo })),
        201,
      );
    }
    if (route === "/uploads" && req.method === "POST") {
      const input = UploadSchema.parse(await jsonBody(req));
      await getKeys(
        owner,
        config,
        input.sources.length ? config.transcriptionModel : null,
      );
      const id = crypto.randomUUID();
      const record = await store(
        "create",
        owner,
        id,
        {
          document: {
            ...uploadDocument(input, id, config.model, config.transcriptionModel),
            analysisId: crypto.randomUUID(),
          },
        },
        "kotonoha_audio_upload",
      );
      return json(expose(record), 201);
    }
    if (route === "/bot/requests" && req.method === "POST") {
      const webhookUrl = Deno.env.get("MEETBOT_WEBHOOK_URL") || "";
      if (!webhookUrl) {
        throw fail(
          503,
          "Bot連携が設定されていません。管理者にBotの接続先（MEETBOT_WEBHOOK_URL）の設定を依頼してください。",
        );
      }
      const input = BotRequestSchema.parse(await jsonBody(req));
      await getKeys(owner, config, config.transcriptionModel);
      const id = crypto.randomUUID();
      const uploadToken = createUploadToken();
      const document = botDocument({
        id,
        requestId: crypto.randomUUID(),
        meetUrl: input.meetUrl,
        metadata: input.metadata,
        model: config.model,
        transcriptionModel: config.transcriptionModel,
      });
      const record: RecordRow = await store(
        "create",
        owner,
        id,
        { document, tokenHash: await hashToken(uploadToken) },
        "kotonoha_bot",
      );
      try {
        await sendBotWebhook(
          webhookUrl,
          Deno.env.get("MEETBOT_WEBHOOK_SECRET") || "",
          webhookPayload({ meeting: record.document, uploadToken, apiBaseUrl: apiBaseUrl() }),
          Deno.env.get("MEETBOT_WEBHOOK_AUTHORIZATION") || "",
        );
      } catch (error) {
        await store("discard", owner, id, {}, "kotonoha_bot").catch(() =>
          console.error("kotonoha bot placeholder cleanup failed"),
        );
        throw error;
      }
      return json(expose(record), 201);
    }
    if (route === "/meetings" && req.method === "POST") {
      const bytes = await bodyBytes(req, MAX_FILE_SIZE + 1_000_000);
      let form: FormData;
      try {
        form = await new Response(bytes, {
          headers: { "Content-Type": req.headers.get("content-type") || "" },
        }).formData();
      } catch {
        throw fail(400, "アップロード形式を確認してください。");
      }
      const metadata = MetadataSchema.parse(
        Object.fromEntries(
          ["title", "date", "participants", "template"].map((k) => [
            k,
            form.get(k) ?? undefined,
          ]),
        ),
      );
      const transcript = z
        .string()
        .trim()
        .max(MAX_TEXT_LENGTH)
        .parse(form.get("transcript") || "");
      const inputs = form.getAll("audio");
      if (inputs.some((audio) => !(audio instanceof File))) {
        throw fail(400, "録音ファイルの形式を確認してください。");
      }
      const audioFiles = inputs as File[];
      if (!audioFiles.length && !transcript) {
        throw fail(400, "録音ファイルか会話テキストを入力してください。");
      }
      if (audioFiles.length && transcript) {
        throw fail(400, "録音とテキストはどちらか一方を選んでください。");
      }
      const keys = await getKeys(
        owner,
        config,
        audioFiles.length ? config.transcriptionModel : null,
      );
      const id = crypto.randomUUID();
      let audioPath: string | null = null;
      const audioParts: Doc[] = [];
      validateRecordings(audioFiles);
      try {
        for (const [index, audio] of audioFiles.entries()) {
          const prepared = await prepareAudio(audio);
          const partPath = `${owner}/${id}/recording-${
            index + 1
          }${prepared.extension}`;
          const { error } = await service.storage
            .from(BUCKET)
            .upload(partPath, prepared.blob, {
              contentType: prepared.contentType || "application/octet-stream",
              upsert: false,
            });
          if (error) {
            throw fail(
              503,
              "音声を保存できませんでした。形式とファイルサイズをご確認ください。",
            );
          }
          audioParts.push({
            fileName: audio.name,
            audioPath: partPath,
            transcript: "",
          });
        }
        audioPath = audioParts[0]?.audioPath || null;
        const document = {
          ...metadata,
          id,
          createdAt: new Date().toISOString(),
          status: audioFiles.length ? "transcribing" : "analyzing",
          source: audioFiles.length ? "audio" : "text",
          isDemo: false,
          fileName: audioFiles[0]?.name || null,
          audioParts,
          duration: null,
          transcript,
          segments: [],
          minutes: null,
          markdown: "",
          speakerNames: {},
          completedActions: [],
          error: null,
          minutesStale: false,
          minutesModel: config.model,
          transcriptionModel: audioFiles.length
            ? config.transcriptionModel
            : null,
          runId: crypto.randomUUID(),
          analysisId: crypto.randomUUID(),
        };
        const record = await store("create", owner, id, {
          document,
          audioPath,
        });
        EdgeRuntime.waitUntil(
          processMeeting(owner, record, keys).catch(() =>
            console.error("kotonoha persistence failure"),
          ),
        );
        return json(expose(record), 202);
      } catch (error) {
        if (audioParts.length) {
          await service.storage
            .from(BUCKET)
            .remove(audioParts.map((part) => part.audioPath));
        }
        throw error;
      }
    }
    const calendarVisibilityMatch = route.match(
      /^\/meetings\/([a-f0-9-]{36})\/calendar\/([a-f0-9]{16})\/(hide|restore)$/,
    );
    if (calendarVisibilityMatch && req.method === "POST") {
      const id = z.uuid().parse(calendarVisibilityMatch[1]),
        eventId = calendarVisibilityMatch[2],
        operation = calendarVisibilityMatch[3];
      const record = await store("get", owner, id);
      if (["uploading", "transcribing", "analyzing"].includes(record.document.status))
        throw fail(409, "解析・取り込み中は予定を変更できません。");
      const value = operation === "hide"
        ? calendarHide(record.document, eventId)
        : calendarRestore(record.document, eventId);
      return json(expose(await store(
        value ? "set" : "reset",
        owner,
        id,
        value ? { eventId, value } : { eventId },
        "kotonoha_calendar",
      )));
    }
    const calendarMatch = route.match(
      /^\/meetings\/([a-f0-9-]{36})\/calendar\/([a-f0-9]{16})$/,
    );
    if (calendarMatch) {
      const id = z.uuid().parse(calendarMatch[1]),
        eventId = calendarMatch[2];
      const record = await store("get", owner, id);
      if (
        ["uploading", "transcribing", "analyzing"].includes(
          record.document.status,
        )
      ) {
        throw fail(409, "解析・取り込み中は予定を変更できません。");
      }
      if (req.method === "PATCH") {
        const value = calendarChange(
          record.document,
          eventId,
          await jsonBody(req),
        );
        return json(
          expose(
            await store(
              "set",
              owner,
              id,
              { eventId, value },
              "kotonoha_calendar",
            ),
          ),
        );
      }
      if (req.method === "DELETE") {
        return json(
          expose(
            await store("reset", owner, id, { eventId }, "kotonoha_calendar"),
          ),
        );
      }
      throw fail(405, "この操作には対応していません。");
    }
    const attachmentMatch = route.match(
      /^\/meetings\/([a-f0-9-]{36})\/attachments(?:\/([a-f0-9-]{36}))?$/,
    );
    if (attachmentMatch) {
      const meetingId = z.uuid().parse(attachmentMatch[1]);
      const attachmentId = attachmentMatch[2]
        ? z.uuid().parse(attachmentMatch[2])
        : null;
      const record: RecordRow = await store("get", owner, meetingId);
      if (req.method === "POST" && !attachmentId) {
        const bytes = await bodyBytes(req, MAX_ATTACHMENT_SIZE + 100_000);
        let form: FormData;
        try {
          form = await new Response(bytes, {
            headers: { "Content-Type": req.headers.get("content-type") || "" },
          }).formData();
        } catch {
          throw fail(400, "資料のアップロード形式を確認してください。");
        }
        const file = form.get("attachment");
        if (!(file instanceof File) || form.getAll("attachment").length !== 1) {
          throw fail(400, "資料を1ファイルずつ送信してください。");
        }
        const id = z.uuid().parse(form.get("id"));
        const digest = record.document.status === "uploading" &&
            record.document.attachmentPlan?.some((entry: Doc) => entry.id === id && entry.sha256)
          ? await attachmentDigest(await file.arrayBuffer())
          : null;
        const submitted = {
          id,
          name: file.name,
          size: file.size,
          uploadedAt: new Date().toISOString(),
        };
        const name = checkAttachmentAdd(record.document, submitted, digest);
        const attachment = {
          ...submitted,
          name,
          type: attachmentTypes[attachmentExtension(name)],
        };
        validateAttachmentBytes(
          name,
          new Uint8Array(await file.slice(0, 1024).arrayBuffer()),
        );
        const storagePath = `${owner}/${meetingId}/${id}-${crypto.randomUUID()}${attachmentExtension(
          name,
        )}`;
        const { error } = await service.storage
          .from(DOCUMENT_BUCKET)
          .upload(storagePath, file, {
            contentType: attachment.type,
            upsert: false,
          });
        if (error) {
          throw fail(
            503,
            "添付資料を保存できませんでした。再度お試しください。",
          );
        }
        try {
          return json(
            expose(
              await store(
                "add",
                owner,
                meetingId,
                { attachment: { ...attachment, storagePath } },
                "kotonoha_attachments",
              ),
            ),
            201,
          );
        } catch (error) {
          if ([400, 404, 409].includes((error as any).status)) {
            await service.storage.from(DOCUMENT_BUCKET).remove([storagePath]);
          }
          throw error;
        }
      }
      const attachment = (record.document.attachments || []).find(
        (f: Doc) => f.id === attachmentId,
      );
      if (!attachment) throw fail(404, "資料が見つかりません。");
      if (req.method === "GET") {
        const { data, error } = await service.storage
          .from(DOCUMENT_BUCKET)
          .createSignedUrl(attachment.storagePath, 600, {
            download: attachment.name,
          });
        if (error || !data) {
          throw fail(503, "資料のダウンロードURLを作成できませんでした。");
        }
        return json({ url: data.signedUrl });
      }
      if (req.method === "DELETE") {
        return json(
          expose(
            await store(
              "remove",
              owner,
              meetingId,
              { attachmentId },
              "kotonoha_attachments",
            ),
          ),
        );
      }
      throw fail(405, "この操作には対応していません。");
    }
    if (route === "/summary" && req.method === "POST") {
      const selection = SummaryRequest.parse(await jsonBody(req));
      const { period } = selection;
      const records: RecordRow[] = await store("list", owner);
      const { meetings, ...range } = periodMeetings(records.map((r) => r.document), selection);
      if (!meetings.length) return json({ summary: "対象期間の会議がありません。", meetingCount: 0, period, ...range });
      const key = await getKey(owner, config, "openai");
      const runId = crypto.randomUUID();
      const result = await openai(key, "/responses", {
        method: "POST", body: JSON.stringify(insightRequest(config.model, "summary", meetings, range)),
      }, 110_000);
      await recordApiUsage(owner, { id: runId, title: "期間サマリー", analysisId: runId }, "minutes", config.model, result, null, "summary");
      return json({ ...parseInsight(result, "summary"), meetingCount: meetings.length, period, ...range });
    }
    if (route === "/suggest-tags" && req.method === "POST") {
      const { meetingId } = TagsRequest.parse(await jsonBody(req));
      const record: RecordRow = await store("get", owner, meetingId);
      const meeting = record.document;
      if (meeting.isDemo || meeting.status !== "done" || !meeting.minutes) throw fail(400, "完了した実際の会議を選択してください。");
      const key = await getKey(owner, config, "openai");
      const result = await openai(key, "/responses", {
        method: "POST", body: JSON.stringify(insightRequest(config.model, "tags", [meeting], undefined)),
      }, 110_000);
      await recordApiUsage(owner, meeting, "minutes", config.model, result, null, "tags", meeting.analysisId);
      return json(parseInsight(result, "tags"));
    }
    const match = route.match(
      /^\/meetings\/([a-f0-9-]{36})(?:\/(audio|retry|parts|complete|bot))?$/,
    );
    if (!match) throw fail(404, "指定された機能が見つかりません。");
    const id = z.uuid().parse(match[1]);
    let record: RecordRow = await store("get", owner, id);
    if (match[2] === "parts" && req.method === "POST") {
      return json(expose(await appendPart(req, owner, id, record)));
    }
    if (match[2] === "complete" && req.method === "POST") {
      record = await completeUpload(owner, id, config, record);
      if (record.document.bot) {
        await store("revoke", owner, id, {}, "kotonoha_bot").catch(() =>
          console.error("kotonoha bot token revoke failed"),
        );
      }
      return json(expose(record), 202);
    }
    if (match[2] === "bot" && req.method === "GET") {
      const view = botView(record.document);
      if (!view) throw fail(404, "この会議はBotで録音していません。");
      return json(view);
    }
    if (match[2] === "audio" && req.method === "GET") {
      const index = Number(new URL(req.url).searchParams.get("part") ?? 0);
      const part =
        Number.isInteger(index) && index >= 0
          ? recordingsFor(record.document, record.audioPath)[index]
          : null;
      if (!part?.audioPath) throw fail(404, "音声ファイルがありません。");
      const { data, error } = await service.storage
        .from(BUCKET)
        .createSignedUrl(part.audioPath, 3600);
      if (error || !data) {
        throw fail(503, "音声の再生URLを作成できませんでした。");
      }
      return json({ url: data.signedUrl });
    }
    if (match[2] === "retry" && req.method === "POST") {
      const options = RetrySchema.parse(await jsonBody(req, true));
      if (record.document.status === "bot") {
        throw fail(409, "Botの録音が届くまでお待ちください。");
      }
      if (record.document.status === "uploading") {
        throw fail(
          409,
          "音声の取り込みが未完了です。会議を削除して再度ファイルを選択してください。",
        );
      }
      if (record.document.isDemo) {
        throw fail(400, "サンプルは再生成できません。");
      }
      const retryTranscriptionModel = needsTranscription(
        record.document,
        record.audioPath,
      )
        ? config.transcriptionModel
        : record.document.transcriptionModel;
      const keys = await getKeys(owner, config, retryTranscriptionModel);
      record = await reconcile(owner, record, keys);
      if (working(record.document)) {
        throw fail(409, "まだ処理中です。完了をお待ちください。");
      }
      record = await store("claim", owner, id, {
        ...options,
        status: needsTranscription(record.document, record.audioPath)
          ? "transcribing"
          : "analyzing",
        error: null,
        minutesModel: config.model,
        transcriptionModel: retryTranscriptionModel,
        transcriptionWait: null,
        geminiRetryCount: 0,
        diagnosticCode: null,
        runId: crypto.randomUUID(),
        analysisId: crypto.randomUUID(),
        partReady: false,
      });
      EdgeRuntime.waitUntil(
        processMeeting(owner, record, keys).catch(() =>
          console.error("kotonoha persistence failure"),
        ),
      );
      return json(expose(record), 202);
    }
    if (!match[2] && req.method === "GET") return json(expose(record));
    if (!match[2] && req.method === "PATCH") {
      const patch: Doc = PatchSchema.parse(await jsonBody(req));
      if (patch.title !== undefined && patch.markdown === undefined) {
        patch.markdown = renameMarkdownHeading(
          record.document.markdown,
          record.document.title,
          patch.title,
        );
      }
      if (
        patch.completedActions?.some(
          (i: number) => i >= (record.document.minutes?.actions.length || 0),
        )
      ) {
        throw fail(400, "アクションが見つかりません。");
      }
      if (
        patch.transcript !== undefined &&
        patch.transcript !== record.document.transcript
      ) {
        Object.assign(patch, { segments: [], minutesStale: true });
      }
      return json(expose(await store("patch", owner, id, patch)));
    }
    if (!match[2] && req.method === "DELETE") {
      await store("delete", owner, id);
      if (
        record.document.status === "uploading" &&
        record.document.audioParts?.length
      ) {
        await service.storage
          .from(BUCKET)
          .remove(record.document.audioParts.map((p: Doc) => p.audioPath));
      }
      return json(null, 204);
    }
    throw fail(405, "この操作には対応していません。");
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json({ error: "入力内容を確認してください。" }, 400);
    }
    const failure = error as any;
    return json(
      { error: failure.publicMessage || safeError(failure) },
      failure.publicMessage ? failure.status : 502,
    );
  }
}
