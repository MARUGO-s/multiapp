import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MeetingStore } from "./store.mjs";
import { UsageStore } from "./usage-store.mjs";
import { meetingDuration } from "../supabase/functions/_shared/duration.mjs";
import { createAI } from "./ai.mjs";
import { SummaryRequest, TagsRequest, periodMeetings, insightRequest, parseInsight } from "../supabase/functions/_shared/insights.mjs";
import { usageEvent } from "../supabase/functions/_shared/usage.mjs";
import {
  createLocalGeminiGate,
  geminiRetryPlan,
  geminiRetryError,
} from "../supabase/functions/_shared/gemini-retry.mjs";
import { createDemo } from "./demo.mjs";
import {
  calendarChange,
  calendarHide,
  calendarRestore,
} from "../supabase/functions/_shared/calendar.mjs";
import { parseMinutes } from "../supabase/functions/_shared/summary.mjs";
import {
  MAX_ATTACHMENT_SIZE,
  attachmentDigest,
  attachmentTypes,
  attachmentExtension,
  checkAttachmentAdd,
  publicAttachments,
  validateAttachmentBytes,
} from "../supabase/functions/_shared/attachments.mjs";
import {
  MAX_BATCH_SIZE,
  UploadSchema,
  uploadDocument,
  uploadPart,
} from "../supabase/functions/_shared/upload.mjs";
import {
  MAX_AUDIO_FILES,
  prepareAudio,
  validateRecordings,
  recordingsFor,
  publicRecordings,
  needsTranscription,
  transcribeRecordings,
} from "../supabase/functions/_shared/audio.mjs";
import {
  MAX_FILE_SIZE,
  MAX_TEXT_LENGTH,
  MetadataSchema,
  RetrySchema,
  PatchSchema,
  minutesMarkdownPatch,
  audioExtensions,
  minutesDocuments,
  safeError,
  transcriptFromSegments,
} from "./domain.mjs";

const models = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
const transcriptionModels = ["gpt-transcribe", "gemini-3.5-transcribe"];
// .env files and config.json written before the GPT Transcribe upgrade; the
// cloud migrates the same value in 20260924000200_kotonoha_gpt_transcribe.sql.
const legacyTranscriptionModels = { "gpt-4o-transcribe": "gpt-transcribe" };
const currentTranscriptionName = (value) =>
  legacyTranscriptionModels[value] || value;
const settingsSchema = z.object({
  apiKey: z.string().trim().min(20).max(500).optional(),
  geminiApiKey: z.string().trim().min(20).max(500).optional(),
  model: z.enum(models),
  transcriptionModel: z.enum(transcriptionModels).default("gpt-transcribe"),
});
const working = (status) => ["transcribing", "analyzing"].includes(status);
const fail = (status, message) =>
  Object.assign(new Error(message), { status, publicMessage: message });
const publicRecord = (record) => {
  const {
    audioFile,
    analysisId,
    audioParts,
    uploadPlan,
    attachments,
    attachmentPlan,
    removedAttachments,
    ...rest
  } = record;
  const recordings = publicRecordings(recordingsFor(record));
  return {
    ...rest,
    duration: meetingDuration(record),
    hasAudio: recordings.length > 0,
    recordings,
    attachments: publicAttachments(record),
  };
};

export async function createApp({
  dataDir,
  apiKey = "",
  geminiApiKey = "",
  model = "gpt-6-astra",
  transcriptionModel = "gpt-transcribe",
  aiFactory = createAI,
  staticDir,
} = {}) {
  const app = express();
  const store = new MeetingStore(path.join(dataDir, "meetings"));
  await store.init();
  const usageStore = new UsageStore(path.join(dataDir, "usage"));
  await usageStore.init();
  const uploadsDir = path.join(dataDir, "audio");
  await mkdir(uploadsDir, { recursive: true, mode: 0o700 });
  const attachmentsDir = path.join(dataDir, "attachments");
  await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(dataDir, "config.json");
  transcriptionModel = currentTranscriptionName(transcriptionModel);
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (models.includes(config.model)) model = config.model;
    const saved = currentTranscriptionName(config.transcriptionModel);
    if (transcriptionModels.includes(saved)) transcriptionModel = saved;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!models.includes(model))
    throw new Error(`OPENAI_MINUTES_MODEL must be one of ${models.join(", ")}`);
  if (!transcriptionModels.includes(transcriptionModel))
    throw new Error(
      `TRANSCRIPTION_MODEL must be one of ${transcriptionModels.join(", ")}`,
    );
  let currentKey = apiKey;
  let currentGeminiKey = geminiApiKey;
  let currentModel = model;
  let currentTranscriptionModel = transcriptionModel;
  const busy = new Set();
  const jobs = new Set();
  const acquireGemini = createLocalGeminiGate();
  let settingsBusy = false;
  async function recordApiUsage(kind, meeting, runId, modelId, response, duration, operation, parentRunId) {
    try {
      await usageStore.record(usageEvent({
        id: randomUUID(), meetingId: meeting.id, meetingTitle: meeting.title, runId,
        kind, model: modelId, response, audioSeconds: duration, operation, parentRunId,
      }));
    } catch (error) {
      console.error("API usage could not be saved", error?.code || error?.name);
    }
  }

  app.disable("x-powered-by");
  app.use("/api", (req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (!["localhost", "127.0.0.1", "[::1]"].includes(req.hostname))
      return next(fail(403, "ローカル環境からアクセスしてください。"));
    if (req.headers.origin) {
      const origin = req.headers.origin;
      const allowed = [
        `http://${req.headers.host}`,
        "http://127.0.0.1:5188",
        "http://localhost:5188",
      ];
      if (!allowed.includes(origin))
        return next(fail(403, "アクセス元を確認できません。"));
    }
    if (!["GET", "HEAD"].includes(req.method) && req.get("X-Kotonoha") !== "1")
      return next(fail(403, "アプリの画面から操作してください。"));
    next();
  });
  app.use(express.json({ limit: "2mb" }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, callback) =>
        callback(
          null,
          `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`,
        ),
    }),
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: MAX_AUDIO_FILES,
      fields: 8,
      fieldSize: 400_000,
    },
    fileFilter: (_req, file, callback) =>
      audioExtensions.has(path.extname(file.originalname).toLowerCase())
        ? callback(null, true)
        : callback(
            fail(
              400,
              "対応する音声ファイル（AAC / MP3 / M4A / WAV / MP4 / WebM / OGG / FLAC）を選択してください。",
            ),
          ),
  });

  function requireKey(_req, _res, next) {
    if (!currentKey)
      return next(fail(428, "接続設定でOpenAI APIキーを設定してください。"));
    if (jobs.size >= 2)
      return next(
        fail(
          429,
          "同時に処理できる会議は2件までです。処理完了後に再度お試しください。",
        ),
      );
    next();
  }
  function getMeeting(id) {
    const meeting = store.get(id);
    if (!meeting) throw fail(404, "会議が見つかりません。");
    return meeting;
  }
  function lock(id) {
    if (busy.has(id))
      throw fail(
        409,
        "この会議は処理中です。完了後にもう一度操作してください。",
      );
    busy.add(id);
  }
  async function processMeeting(
    id,
    runId,
    key,
    geminiKey,
    modelForJob,
    transcriptionModelForJob,
  ) {
    try {
      const ai = aiFactory(
        key,
        modelForJob,
        {},
        {
          transcriptionModel: transcriptionModelForJob,
          geminiApiKey: geminiKey,
        },
      );
      let meeting = await store.save({ ...getMeeting(id), analysisId: runId });
      const gemini = transcriptionModelForJob === "gemini-3.5-transcribe";
      async function transcribePart(part) {
        const duration = part.duration || (recordingsFor(meeting).length === 1
          ? meeting.duration : null);
        const file = path.join(uploadsDir, part.audioFile);
        const usageFor = (model) => (response) => recordApiUsage(
          "transcription", meeting, runId, model, response, duration,
        );
        const onUsage = usageFor(transcriptionModelForJob);
        // A part Gemini could not finish is transcribed with GPT Transcribe.
        const fallback = async (geminiStatus) => ({
          transcript: (await aiFactory(key, modelForJob, {}, {
            transcriptionModel: "gpt-transcribe",
          }).transcribe(file, usageFor("gpt-transcribe"))).transcript,
          transcriptionFallback: { model: "gpt-transcribe", geminiStatus },
        });
        if (!gemini) return (await ai.transcribe(file, onUsage)).transcript;
        if (part.transcriptionFallback)
          return fallback(part.transcriptionFallback.geminiStatus);
        let incomplete;
        for (;;) {
          const release = await acquireGemini(async (until, reason) => {
            meeting = await store.save({
              ...meeting,
              transcriptionWait: {
                until,
                reason,
                attempt: meeting.geminiRetryCount || 0,
              },
            });
          });
          let delayMs, reason;
          try {
            meeting = await store.save({ ...meeting, transcriptionWait: null });
            const result = await ai.transcribe(file, onUsage);
            meeting = await store.save({ ...meeting, geminiRetryCount: 0 });
            return result.transcript;
          } catch (error) {
            if (error.code === "GEMINI_TRANSCRIPT_INCOMPLETE") {
              incomplete = error.geminiStatus || "unknown";
              break;
            }
            const retry = geminiRetryPlan(error, meeting.geminiRetryCount || 0);
            if (!retry) throw error;
            if (retry.stop) throw geminiRetryError(retry.stop);
            delayMs = retry.delayMs;
            reason = "rate_limit";
            meeting = await store.save({
              ...meeting,
              geminiRetryCount: retry.attempt,
              transcriptionWait: {
                until: retry.until,
                reason,
                attempt: retry.attempt,
              },
            });
          } finally {
            release(delayMs, reason);
          }
        }
        return fallback(incomplete);
      }
      if (needsTranscription(meeting) || !meeting.transcript) {
        let transcript;
        do {
          transcript = await transcribeRecordings(
            recordingsFor(meeting),
            transcribePart,
            async (audioParts) => {
              meeting = await store.save({ ...meeting, audioParts });
            },
            meeting.chunked || gemini ? 1 : Infinity,
          );
        } while (transcript === null);
        meeting = await store.save({
          ...meeting,
          transcript,
          segments: [],
          status: "analyzing",
          transcriptionModel: transcriptionModelForJob,
        });
      }
      const minutes = parseMinutes(meeting, await ai.summarize(
        meeting,
        (response) => recordApiUsage("minutes", meeting, runId, modelForJob, response, null),
      ));
      await store.save({
        ...meeting,
        status: "done",
        minutes,
        ...minutesDocuments(meeting, minutes),
        completedActions: [],
        error: null,
        minutesStale: false,
        minutesModel: modelForJob,
      });
    } catch (error) {
      const latest = store.get(id);
      if (latest)
        await store.save({
          ...latest,
          status: "error",
          error: error.publicMessage || safeError(error),
          transcriptionWait: null,
        });
      console.error(
        "Meeting processing failed:",
        error.name,
        error.status || error.code || "unknown",
      );
    } finally {
      busy.delete(id);
    }
  }
  function startJob(id) {
    const meeting = getMeeting(id);
    const job = processMeeting(
      id,
      randomUUID(),
      currentKey,
      currentGeminiKey,
      currentModel,
      meeting.transcriptionModel || currentTranscriptionModel,
    );
    jobs.add(job);
    // A storage error must not become an unhandled rejection or expose API content.
    job
      .catch(() => console.error("Meeting result could not be saved."))
      .finally(() => jobs.delete(job));
  }

  app.get("/api/settings", (_req, res) =>
    res.json({
      configured: Boolean(currentKey),
      geminiConfigured: Boolean(currentGeminiKey),
      model: currentModel,
      transcriptionModel: currentTranscriptionModel,
      maxFileSize: MAX_BATCH_SIZE,
    }),
  );
  app.get("/api/usage", (req, res) => {
    const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).parse(req.query.month);
    const page = z.coerce.number().int().min(0).max(100000).parse(req.query.page ?? 0);
    res.json(usageStore.month(month, page));
  });
  app.put("/api/settings", async (req, res) => {
    const input = settingsSchema.parse(req.body);
    if (settingsBusy) throw fail(409, "設定を保存中です。");
    settingsBusy = true;
    try {
      const temp = `${configPath}.tmp`;
      if (
        input.transcriptionModel === "gemini-3.5-transcribe" &&
        !input.geminiApiKey &&
        !currentGeminiKey
      )
        throw fail(428, "Gemini APIキーを入力してください。");
      await writeFile(
        temp,
        JSON.stringify({
          model: input.model,
          transcriptionModel: input.transcriptionModel,
        }),
        {
          mode: 0o600,
        },
      );
      await rename(temp, configPath);
      if (input.apiKey) currentKey = input.apiKey;
      if (input.geminiApiKey) currentGeminiKey = input.geminiApiKey;
      currentModel = input.model;
      currentTranscriptionModel = input.transcriptionModel;
      res.json({
        configured: Boolean(currentKey),
        geminiConfigured: Boolean(currentGeminiKey),
        model: currentModel,
        transcriptionModel: currentTranscriptionModel,
        maxFileSize: MAX_BATCH_SIZE,
      });
    } finally {
      settingsBusy = false;
    }
  });
  app.get("/api/meetings", (_req, res) =>
    res.json(store.list().map(publicRecord)),
  );
  app.get("/api/meetings/:id", (req, res) =>
    res.json(publicRecord(getMeeting(req.params.id))),
  );

  app.post("/api/demo", async (_req, res) => {
    const existing = store.list().find((m) => m.isDemo);
    const meeting = existing || (await store.save(createDemo()));
    res.status(existing ? 200 : 201).json(publicRecord(meeting));
  });
  app.post("/api/uploads", requireKey, async (req, res) => {
    const input = UploadSchema.parse(req.body);
    if (store.list().filter((m) => m.status === "uploading").length >= 2)
      throw fail(
        429,
        "取り込み途中の会議を削除してから再度取り込んでください。",
      );
    if (
      input.sources.length &&
      currentTranscriptionModel === "gemini-3.5-transcribe" &&
      !currentGeminiKey
    )
      throw fail(428, "接続設定でGemini APIキーを設定してください。");
    const doc = uploadDocument(
      input,
      randomUUID(),
      currentModel,
      currentTranscriptionModel,
    );
    await store.save(doc);
    res.status(201).json(publicRecord(doc));
  });
  app.post(
    "/api/meetings/:id/parts",
    express.raw({ type: () => true, limit: MAX_FILE_SIZE }),
    async (req, res) => {
      const id = req.params.id;
      lock(id);
      let destination;
      let saved = false;
      try {
        const doc = getMeeting(id);
        let expected;
        try {
          expected = uploadPart(doc, Number(req.query.index));
        } catch (error) {
          throw fail(409, error.message);
        }
        if (!Buffer.isBuffer(req.body) || req.body.length !== expected.size)
          throw fail(400, "録音のサイズが一致しません。");
        const audioFile = `${randomUUID()}${path.extname(expected.name)}`;
        destination = path.join(uploadsDir, audioFile);
        await writeFile(destination, req.body, { mode: 0o600 });
        const next = await store.save({
          ...doc,
          audioParts: [
            ...doc.audioParts,
            { ...expected, audioFile, transcript: "" },
          ],
        });
        saved = true;
        res.json(publicRecord(next));
      } finally {
        busy.delete(id);
        if (!saved && destination) await unlink(destination).catch(() => {});
      }
    },
  );
  app.post("/api/meetings/:id/complete", requireKey, async (req, res) => {
    const doc = getMeeting(req.params.id);
    if (doc.status !== "uploading")
      return res.status(202).json(publicRecord(doc));
    lock(doc.id);
    try {
      if (
        doc.audioParts.length !== doc.uploadPlan.length ||
        (doc.attachments || []).length !== (doc.attachmentPlan || []).length
      )
        throw fail(409, "音声・添付資料の取り込みが未完了です。");
      if (
        doc.audioParts.length &&
        doc.transcriptionModel === "gemini-3.5-transcribe" &&
        !currentGeminiKey
      )
        throw fail(428, "接続設定でGemini APIキーを設定してください。");
      const next = await store.save({
        ...doc,
        status: doc.audioParts.length ? "transcribing" : "analyzing",
      });
      startJob(doc.id);
      res.status(202).json(publicRecord(next));
    } catch (error) {
      busy.delete(doc.id);
      throw error;
    }
  });
  app.post(
    "/api/meetings",
    requireKey,
    upload.array("audio", MAX_AUDIO_FILES),
    async (req, res) => {
      let accepted = false;
      const files = req.files || [];
      const cleanupPaths = new Set(files.map((file) => file.path));
      try {
        const metadata = MetadataSchema.parse(req.body);
        const transcript = z
          .string()
          .trim()
          .max(MAX_TEXT_LENGTH)
          .parse(req.body.transcript || "");
        if (!files.length && !transcript)
          throw fail(400, "音声ファイルまたは会話テキストを入力してください。");
        if (files.length && transcript)
          throw fail(400, "音声とテキストはどちらか一方を選択してください。");
        if (
          files.length &&
          currentTranscriptionModel === "gemini-3.5-transcribe" &&
          !currentGeminiKey
        )
          throw fail(428, "接続設定でGemini APIキーを設定してください。");
        validateRecordings(
          files.map((file) => ({ name: file.originalname, size: file.size })),
        );
        if (jobs.size >= 2)
          throw fail(
            429,
            "処理中の会議が完了してから、もう一度お試しください。",
          );
        const audioParts = [];
        for (const file of files) {
          const fileName = Buffer.from(file.originalname, "latin1").toString(
            "utf8",
          );
          if (path.extname(file.filename) === ".aac") {
            const prepared = await prepareAudio(
              new File([await readFile(file.path)], fileName),
            );
            const filename = `${path.parse(file.filename).name}${prepared.extension}`;
            const destination = path.join(uploadsDir, filename);
            cleanupPaths.add(destination);
            await writeFile(
              destination,
              new Uint8Array(await prepared.blob.arrayBuffer()),
              { mode: 0o600 },
            );
            await unlink(file.path);
            file.filename = filename;
            file.path = destination;
          }
          audioParts.push({
            fileName,
            audioFile: file.filename,
            transcript: "",
          });
        }
        const meeting = {
          ...metadata,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          status: files.length ? "transcribing" : "analyzing",
          source: files.length ? "audio" : "text",
          isDemo: false,
          fileName: audioParts[0]?.fileName || null,
          audioFile: audioParts[0]?.audioFile || null,
          audioParts,
          transcript,
          segments: [],
          duration: null,
          minutes: null,
          markdown: "",
          speakerNames: {},
          completedActions: [],
          error: null,
          minutesStale: false,
          minutesModel: currentModel,
          transcriptionModel: files.length ? currentTranscriptionModel : null,
        };
        lock(meeting.id);
        try {
          await store.save(meeting);
        } catch (error) {
          busy.delete(meeting.id);
          throw error;
        }
        accepted = true;
        startJob(meeting.id);
        res.status(202).json(publicRecord(meeting));
      } finally {
        if (!accepted)
          await Promise.all(
            [...cleanupPaths].map((file) => unlink(file).catch(() => {})),
          );
      }
    },
  );

  app.post("/api/meetings/:id/retry", requireKey, async (req, res) => {
    const options = RetrySchema.parse(req.body === undefined ? {} : req.body);
    const meeting = getMeeting(req.params.id);
    if (meeting.status === "uploading")
      throw fail(
        409,
        "音声の取り込みが未完了です。削除してファイルを選び直してください。",
      );
    if (meeting.isDemo)
      throw fail(
        400,
        "サンプル会議は再生成できません。新しい会議でお試しください。",
      );
    if (
      needsTranscription(meeting) &&
      currentTranscriptionModel === "gemini-3.5-transcribe" &&
      !currentGeminiKey
    )
      throw fail(428, "接続設定でGemini APIキーを設定してください。");
    lock(meeting.id);
    try {
      const next = await store.save({
        ...meeting,
        ...options,
        status: needsTranscription(meeting) ? "transcribing" : "analyzing",
        error: null,
        geminiRetryCount: 0,
        transcriptionWait: null,
        minutesModel: currentModel,
        ...(needsTranscription(meeting)
          ? { transcriptionModel: currentTranscriptionModel }
          : {}),
      });
      startJob(meeting.id);
      res.status(202).json(publicRecord(next));
    } catch (error) {
      busy.delete(meeting.id);
      throw error;
    }
  });

  app.patch("/api/meetings/:id/calendar/:eventId", async (req, res) => {
    const id = req.params.id;
    lock(id);
    try {
      const m = getMeeting(id);
      if (working(m.status) || m.status === "uploading")
        throw fail(409, "解析・取り込み中は予定を変更できません。");
      if (!/^[a-f0-9]{16}$/.test(req.params.eventId))
        throw fail(400, "予定IDが不正です。");
      const value = calendarChange(m, req.params.eventId, req.body);
      const edits = {
        ...(m.calendarOverrides || {}),
        [req.params.eventId]: value,
      };
      if (Object.keys(edits).length > 200)
        throw fail(400, "1会議の手動予定は200件までです。");
      res.json(
        publicRecord(await store.save({ ...m, calendarOverrides: edits })),
      );
    } finally {
      busy.delete(id);
    }
  });
  app.delete("/api/meetings/:id/calendar/:eventId", async (req, res) => {
    const id = req.params.id;
    lock(id);
    try {
      const m = getMeeting(id);
      if (working(m.status) || m.status === "uploading")
        throw fail(409, "解析・取り込み中は予定を変更できません。");
      const edits = { ...(m.calendarOverrides || {}) };
      delete edits[req.params.eventId];
      res.json(
        publicRecord(await store.save({ ...m, calendarOverrides: edits })),
      );
    } finally {
      busy.delete(id);
    }
  });
  app.post("/api/meetings/:id/calendar/:eventId/:operation", async (req, res) => {
    const { id, eventId, operation } = req.params;
    if (!/^[a-f0-9]{16}$/.test(eventId) || !["hide", "restore"].includes(operation))
      throw fail(400, "予定の操作が不正です。");
    lock(id);
    try {
      const meeting = getMeeting(id);
      if (working(meeting.status) || meeting.status === "uploading")
        throw fail(409, "解析・取り込み中は予定を変更できません。");
      const value = operation === "hide"
        ? calendarHide(meeting, eventId)
        : calendarRestore(meeting, eventId);
      const edits = { ...(meeting.calendarOverrides || {}) };
      if (value) edits[eventId] = value;
      else delete edits[eventId];
      if (Object.keys(edits).length > 200)
        throw fail(400, "1会議の手動予定は200件までです。");
      res.json(publicRecord(await store.save({ ...meeting, calendarOverrides: edits })));
    } finally {
      busy.delete(id);
    }
  });
  app.patch("/api/meetings/:id", async (req, res) => {
    const meeting = getMeeting(req.params.id);
    lock(meeting.id);
    try {
      const patch = minutesMarkdownPatch(meeting, PatchSchema.parse(req.body));
      let next = { ...meeting, ...patch };
      if (
        patch.completedActions?.some(
          (i) => i >= (meeting.minutes?.actions.length || 0),
        )
      )
        throw fail(400, "アクションが見つかりません。");
      if (
        patch.transcript !== undefined &&
        patch.transcript !== meeting.transcript
      )
        next = { ...next, segments: [], minutesStale: true };
      if (patch.speakerNames && meeting.segments.length)
        next = {
          ...next,
          transcript: transcriptFromSegments(
            meeting.segments,
            patch.speakerNames,
          ),
          minutesStale: true,
        };
      res.json(publicRecord(await store.save(next)));
    } finally {
      busy.delete(meeting.id);
    }
  });
  const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_ATTACHMENT_SIZE,
      files: 1,
      fields: 1,
      fieldSize: 100,
    },
  });
  app.post(
    "/api/meetings/:id/attachments",
    attachmentUpload.single("attachment"),
    async (req, res) => {
      const meetingId = req.params.id;
      lock(meetingId);
      let destination,
        accepted = false;
      try {
        const meeting = getMeeting(meetingId),
          file = req.file;
        if (!file) throw fail(400, "添付資料を選択してください。");
        const receivedName = Buffer.from(file.originalname, "latin1").toString("utf8");
        const digest = meeting.status === "uploading" &&
            meeting.attachmentPlan?.some((entry) => entry.id === req.body.id && entry.sha256)
          ? await attachmentDigest(file.buffer)
          : null;
        const name = checkAttachmentAdd(meeting, {
          id: z.uuid().parse(req.body.id),
          name: receivedName,
          size: file.size,
        }, digest);
        const attachment = {
          id: z.uuid().parse(req.body.id),
          name,
          size: file.size,
          type: attachmentTypes[attachmentExtension(name)],
          uploadedAt: new Date().toISOString(),
        };
        validateAttachmentBytes(name, file.buffer);
        const localFile = `${randomUUID()}${attachmentExtension(name)}`;
        destination = path.join(attachmentsDir, localFile);
        await writeFile(destination, file.buffer, { mode: 0o600 });
        const saved = await store.save({
          ...meeting,
          attachments: [
            ...(meeting.attachments || []),
            { ...attachment, localFile },
          ],
        });
        accepted = true;
        res.status(201).json(publicRecord(saved));
      } finally {
        busy.delete(meetingId);
        if (destination && !accepted) await unlink(destination).catch(() => {});
      }
    },
  );
  app.get("/api/meetings/:id/attachments/:attachmentId", (req, res) => {
    const meeting = getMeeting(req.params.id),
      attachment = meeting.attachments?.find(
        (f) => f.id === req.params.attachmentId,
      );
    if (!attachment) throw fail(404, "資料が見つかりません。");
    res.download(
      path.join(attachmentsDir, attachment.localFile),
      attachment.name,
    );
  });
  app.delete(
    "/api/meetings/:id/attachments/:attachmentId",
    async (req, res) => {
      const meetingId = req.params.id;
      lock(meetingId);
      try {
        const meeting = getMeeting(meetingId);
        if (working(meeting.status) || meeting.status === "uploading")
          throw fail(409, "解析・取り込み中は資料を解除できません。");
        const attachment = meeting.attachments?.find(
          (f) => f.id === req.params.attachmentId,
        );
        if (!attachment) throw fail(404, "資料が見つかりません。");
        res.json(
          publicRecord(
            await store.save({
              ...meeting,
              attachments: meeting.attachments.filter(
                (f) => f.id !== attachment.id,
              ),
              removedAttachments: [
                ...(meeting.removedAttachments || []),
                { ...attachment, removedAt: new Date().toISOString() },
              ],
            }),
          ),
        );
      } finally {
        busy.delete(meetingId);
      }
    },
  );
  app.get("/api/meetings/:id/audio", (req, res) => {
    const meeting = getMeeting(req.params.id);
    const index = Number(req.query.part ?? 0);
    const part =
      Number.isInteger(index) && index >= 0
        ? recordingsFor(meeting)[index]
        : null;
    if (!part?.audioFile)
      throw fail(404, "この会議に音声ファイルはありません。");
    res.sendFile(part.audioFile, { root: uploadsDir, dotfiles: "deny" });
  });
  app.delete("/api/meetings/:id", async (req, res) => {
    const meeting = getMeeting(req.params.id);
    lock(meeting.id);
    try {
      if (working(meeting.status))
        throw fail(409, "処理中の会議は削除できません。");
      // Move to a local trash directory so accidental deletion is recoverable.
      const trashDir = path.join(dataDir, "trash", meeting.id);
      await mkdir(trashDir, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(trashDir, "meeting.json"),
        JSON.stringify(meeting, null, 2),
        { mode: 0o600 },
      );
      for (const part of recordingsFor(meeting))
        await rename(
          path.join(uploadsDir, part.audioFile),
          path.join(trashDir, part.audioFile),
        );
      for (const attachment of [
        ...(meeting.attachments || []),
        ...(meeting.removedAttachments || []),
      ])
        await rename(
          path.join(attachmentsDir, attachment.localFile),
          path.join(trashDir, attachment.localFile),
        );
      await store.delete(meeting.id);
      res.status(204).end();
    } finally {
      busy.delete(meeting.id);
    }
  });
  let insightJobs = 0;
  async function generateInsight(operation, meetings, range) {
    if (insightJobs >= 2) throw fail(429, "AI生成中です。完了後にもう一度お試しください。");
    insightJobs++;
    const modelForRequest = currentModel;
    const parentRunId = operation === "tags" ? meetings[0].analysisId : undefined;
    const runId = parentRunId || randomUUID();
    const meeting = operation === "tags" ? meetings[0] : { id: runId, title: "期間サマリー" };
    try {
      const ai = aiFactory(currentKey, modelForRequest, { maxRetries: 0, timeout: 110_000 });
      const result = await ai.insight(insightRequest(modelForRequest, operation, meetings, range),
        (response) => recordApiUsage("minutes", meeting, runId, modelForRequest, response, null, operation, parentRunId));
      return parseInsight(result, operation);
    } catch (error) {
      if (error.publicMessage) throw error;
      throw fail(502, safeError(error));
    } finally { insightJobs--; }
  }
  app.post("/api/summary", async (req, res) => {
    const selection = SummaryRequest.parse(req.body);
    const { period } = selection;
    const { meetings, ...range } = periodMeetings(store.list(), selection);
    if (!meetings.length) return res.json({ summary: "対象期間の会議がありません。", meetingCount: 0, period, ...range });
    if (!currentKey) throw fail(428, "接続設定でOpenAI APIキーを設定してください。");
    res.json({ ...await generateInsight("summary", meetings, range), meetingCount: meetings.length, period, ...range });
  });
  app.post("/api/suggest-tags", requireKey, async (req, res) => {
    const { meetingId } = TagsRequest.parse(req.body);
    const meeting = getMeeting(meetingId);
    if (meeting.isDemo || meeting.status !== "done" || !meeting.minutes) throw fail(400, "完了した実際の会議を選択してください。");
    res.json(await generateInsight("tags", [meeting]));
  });
  app.use("/api", (_req, _res, next) =>
    next(fail(404, "APIが見つかりません。")),
  );
  if (staticDir) {
    app.use(express.static(staticDir));
    app.get("/", (_req, res) =>
      res.sendFile(path.join(staticDir, "index.html")),
    );
  }
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: `入力内容を確認してください。${error.issues[0]?.message || ""}`,
      });
    if (error instanceof multer.MulterError)
      return res.status(400).json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? _req.path.includes("/attachments")
              ? "添付資料は1ファイル10 MBまでです。"
              : "音声ファイルは24 MB以下にしてください。"
            : "アップロードの制限を超えました。ファイルと入力内容をご確認ください。",
      });
    const status = error.status || 500;
    res.status(status).json({
      error:
        error.publicMessage ||
        (status === 413
          ? "入力データが大きすぎます。"
          : "処理に失敗しました。アプリを再読み込みしてお試しください。"),
    });
  });
  return { app, store, waitForJobs: () => Promise.allSettled([...jobs]) };
}
