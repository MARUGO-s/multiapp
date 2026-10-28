import { z } from "zod";
import { MetadataSchema, MAX_FILE_SIZE, MAX_TEXT_LENGTH } from "./domain.mjs";
import { AttachmentPlanSchema } from "./attachments.mjs";
import { RecordingLocationSchema } from "./recording-location.mjs";
export const MAX_BATCH_SIZE = 100_000_000;
const SourceSchema = z
  .object({
    name: z.string().min(1).max(500),
    size: z.number().int().positive().max(MAX_BATCH_SIZE),
    startLocation: RecordingLocationSchema.optional(),
  })
  .strict();
const PartSchema = z
  .object({
    name: z.string().regex(/^recording-\d+-\d+\.(m4a|mp3|wav|ogg|flac)$/),
    size: z.number().int().positive().max(MAX_FILE_SIZE),
    sourceIndex: z.number().int().min(0).max(4),
    partNumber: z.number().int().positive(),
    duration: z.number().positive().max(610),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();
export const UploadSchema = z
  .object({
    uploadId: z.string().uuid().optional(),
    metadata: MetadataSchema,
    sources: z.array(SourceSchema).max(5),
    parts: z.array(PartSchema).max(512),
    transcript: z.string().trim().max(MAX_TEXT_LENGTH).default(""),
    attachments: AttachmentPlanSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const bad = (message) => ctx.addIssue({ code: "custom", message });
    if (value.uploadId && [...value.parts, ...value.attachments].some(p => !p.sha256)) bad("再送用のファイルハッシュが不足しています。");
    if (Boolean(value.sources.length) === Boolean(value.transcript))
      bad("音声または会話テキストのどちらか一方を入力してください。");
    if (value.sources.reduce((n, s) => n + s.size, 0) > MAX_BATCH_SIZE)
      bad("録音は合計100 MBまでです。");
    if (value.parts.reduce((n, p) => n + p.size, 0) > 110_000_000)
      bad("分割後のデータ量が上限を超えています。");
    let index = 0;
    for (const [sourceIndex] of value.sources.entries()) {
      let number = 1;
      while (value.parts[index]?.sourceIndex === sourceIndex) {
        if (value.parts[index].partNumber !== number++)
          bad("録音の分割順序が不正です。");
        index++;
      }
      if (number === 1) bad("音声が不足しています。");
    }
    if (index !== value.parts.length) bad("録音の順序が不正です。");
  });
export function uploadDocument(
  input,
  id,
  model,
  transcriptionModel = "gpt-transcribe",
) {
  return {
    ...(input.uploadId ? { uploadInput: input } : {}),
    ...input.metadata,
    id,
    createdAt: new Date().toISOString(),
    status: "uploading",
    source: input.sources.length ? "audio" : "text",
    isDemo: false,
    fileName: input.sources[0]?.name || null,
    sources: input.sources,
    recordingLocations: input.sources.flatMap((source, sourceIndex) =>
      source.startLocation ? [{ sourceIndex, ...source.startLocation }] : []),
    uploadPlan: input.parts,
    audioParts: [],
    attachmentPlan: input.attachments || [],
    attachments: [],
    chunked: true,
    duration: null,
    transcript: input.transcript || "",
    segments: [],
    minutes: null,
    markdown: "",
    speakerNames: {},
    completedActions: [],
    error: null,
    minutesStale: false,
    minutesModel: model,
    transcriptionModel: input.sources.length ? transcriptionModel : null,
  };
}
export async function uploadDigest(input) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(input)));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

export function uploadPart(document, index) {
  if (document.status !== "uploading")
    throw Object.assign(new Error("アップロードは終了しています。"), {
      status: 409,
    });
  const part = document.uploadPlan?.[index];
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !part ||
    index !== document.audioParts.length
  )
    throw Object.assign(
      new Error("録音を先頭から順番にアップロードしてください。"),
      { status: 409 },
    );
  return {
    ...part,
    fileName: `${document.sources[part.sourceIndex].name}（${part.partNumber}）`,
  };
}
