// In-app viewing of meeting attachments. Content is always shown as data:
// images in <img>, PDF through pdf.js on a canvas, CSV/TXT as plain text.
// Nothing is rendered as HTML, and Office files stay download-only.
import { attachmentExtension } from "../supabase/functions/_shared/attachments.mjs";

export const MAX_TEXT_PREVIEW = 200_000;
export const MAX_CSV_ROWS = 500;

const IMAGE = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"]);

/** @returns {"image" | "pdf" | "csv" | "text" | null} */
export function previewKind(name) {
  const ext = attachmentExtension(String(name || ""));
  if (IMAGE.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".csv") return "csv";
  if (ext === ".txt") return "text";
  return null;
}

// UTF-8 first; files saved by Excel or older Windows tools are often Shift_JIS.
export function decodePreviewText(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder("shift_jis").decode(bytes);
    } catch {
      text = new TextDecoder("utf-8").decode(bytes);
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const truncated = text.length > MAX_TEXT_PREVIEW;
  return { text: truncated ? text.slice(0, MAX_TEXT_PREVIEW) : text, truncated };
}

// RFC 4180: quoted cells may hold commas, doubled quotes and line breaks.
export function parseCsv(text, maxRows = MAX_CSV_ROWS) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (rows.length >= maxRows) truncated = true;
    else rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length && !truncated; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else cell += c;
  }
  if (!truncated && (cell !== "" || row.length)) endRow();
  return { rows, truncated };
}
