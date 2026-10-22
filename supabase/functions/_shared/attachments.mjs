import { z } from "zod";
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_SIZE = 10_000_000;
export const MAX_ATTACHMENT_TOTAL = 25_000_000;
/** @type {Record<string,string>} */
export const attachmentTypes = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".csv": "text/csv",
  ".txt": "text/plain",
  // Photos and screenshots. SVG is excluded: it can carry scripts.
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};
export const attachmentExtension = (name) =>
  `.${name.split(".").pop().toLowerCase()}`;
export const isImageAttachment = (name) =>
  (attachmentTypes[attachmentExtension(name)] || "").startsWith("image/");
export const ATTACHMENT_KINDS_LABEL =
  "PDF・Excel（xls/xlsx）・Word（doc/docx）・PowerPoint・CSV・TXT・画像（JPEG・PNG・GIF・WebP・HEIC）";
const fail = (message) =>
  Object.assign(new Error(message), { status: 400, publicMessage: message });
export async function attachmentDigest(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}
export function validateAttachments(files) {
  if (files.length > MAX_ATTACHMENTS)
    throw fail("添付資料は1会議につき5ファイルまでです。");
  if (files.some((f) => !f.size || f.size > MAX_ATTACHMENT_SIZE))
    throw fail(
      "添付資料は空ではない、1ファイル10 MB以下のファイルを選んでください。",
    );
  if (files.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENT_TOTAL)
    throw fail(
      "添付資料は合計25 MB以下にしてください（録音の100 MB枠とは別枠です）。",
    );
  if (
    files.some(
      (f) =>
        !attachmentTypes[attachmentExtension(f.name)] ||
        /[\u0000-\u001f\u007f\\/]/.test(f.name) ||
        f.name.length > 250,
    )
  )
    throw fail(
      `${ATTACHMENT_KINDS_LABEL}の資料を選んでください。`,
    );
}
export const AttachmentPlanSchema = z
  .array(
    z
      .object({
        id: z.uuid(),
        name: z.string().min(1).max(250),
        size: z.number().int().positive().max(MAX_ATTACHMENT_SIZE),
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      })
      .strict(),
  )
  .max(MAX_ATTACHMENTS)
  .default([])
  .superRefine((files, ctx) => {
    try {
      validateAttachments(files);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: e.message });
    }
    if (new Set(files.map((f) => f.id)).size !== files.length)
      ctx.addIssue({ code: "custom", message: "資料IDが重複しています。" });
  });
/** @param {string | null} [digest] */
export function checkAttachmentAdd(document, attachment, digest = null) {
  if (["transcribing", "analyzing"].includes(document.status))
    throw Object.assign(
      fail("解析中は資料を変更できません。完了後に追加してください。"),
      { status: 409 },
    );
  if (document.isDemo)
    throw fail(
      "サンプルには資料を追加できません。実際の会議に追加してください。",
    );
  if ((document.attachments || []).some((f) => f.id === attachment.id))
    throw Object.assign(fail("この資料はすでに保存されています。"), {
      status: 409,
    });
  if (document.status === "uploading") {
    const expected = document.attachmentPlan?.find(
      (f) => f.id === attachment.id,
    );
    if (!expected || expected.size !== attachment.size ||
      (!expected.sha256 && expected.name.normalize("NFC") !== attachment.name.normalize("NFC")))
      throw fail("選択時の添付資料と一致しません。");
    if (expected.sha256 && expected.sha256 !== digest)
      throw fail("添付資料の内容が選択時と一致しません。もう一度選び直してください。");
    validateAttachments([...(document.attachments || []), { ...attachment, name: expected.name }]);
    return expected.name;
  }
  validateAttachments([...(document.attachments || []), attachment]);
  return attachment.name;
}
export function publicAttachments(document) {
  return (document.attachments || []).map(
    ({ id, name, size, type, uploadedAt }) => ({
      id,
      name,
      size,
      type,
      uploadedAt,
    }),
  );
}
// Header validation does not execute or unpack Office documents.
export function validateAttachmentBytes(name, bytes) {
  const ext = attachmentExtension(name),
    signature = (...values) => values.every((v, i) => bytes[i] === v);
  if (
    ext === ".pdf" &&
    !new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")
  )
    throw fail("PDFの形式を確認できません。PDFとして書き出し直してください。");
  if ([".xlsx", ".docx", ".pptx"].includes(ext) && !signature(80, 75, 3, 4))
    throw fail(
      "Officeファイルの形式を確認できません。パスワードを解除し、標準形式で保存し直してください。",
    );
  if (
    [".xls", ".doc", ".ppt"].includes(ext) &&
    !signature(208, 207, 17, 224, 161, 177, 26, 225)
  )
    throw fail(
      "旧Officeファイルの形式を確認できません。xlsx・docx・pptxかPDFで書き出してください。",
    );
  if (attachmentTypes[ext]?.startsWith("image/") && !imageMatches(ext, bytes))
    throw fail(
      "画像の形式を確認できません。JPEG・PNGなどで保存し直してください。",
    );
}
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
function imageMatches(ext, bytes) {
  const at = (offset, text) =>
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (ext === ".jpg" || ext === ".jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === ".png")
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v);
  if (ext === ".gif") return at(0, "GIF87a") || at(0, "GIF89a");
  if (ext === ".webp") return at(0, "RIFF") && at(8, "WEBP");
  if (ext === ".heic" || ext === ".heif")
    return at(4, "ftyp") &&
      HEIF_BRANDS.has(String.fromCharCode(...bytes.subarray(8, 12)));
  return false;
}
