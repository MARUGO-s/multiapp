export const QR_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const QR_FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.html,.htm";
export const QR_FILE_TYPE_LABEL = "PDF・JPG・PNG・HTML";
export function fileSpecification(name, size) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 180 ||
    /[\u0000-\u001f\u007f/\\]/.test(name)
  )
    throw new Error("ファイル名を確認してください（180文字以内）。");
  if (!Number.isInteger(size) || size < 1 || size > QR_FILE_MAX_BYTES)
    throw new Error("ファイルは20MB以下にしてください。");
  const extension = name.split(".").at(-1)?.toLowerCase();
  const type = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    html: "text/html",
    htm: "text/html",
  }[extension];
  if (!type)
    throw new Error(`${QR_FILE_TYPE_LABEL}ファイルを選択してください。`);
  return {
    fileName: name.trim(),
    size,
    mime: type,
    extension: extension === "jpeg" ? "jpg" : extension === "htm" ? "html" : extension,
  };
}
function isHtmlDocument(bytes) {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0) return false;
  while (
    start < bytes.length &&
    (bytes[start] === 9 || bytes[start] === 10 || bytes[start] === 13 || bytes[start] === 32)
  ) start += 1;
  return bytes[start] === 0x3c;
}
export function matchesFileSignature(mime, bytes) {
  if (mime === "application/pdf")
    return new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  if (mime === "text/html") return isHtmlDocument(bytes);
  return false;
}
export function responseMimeMatches(expected, header) {
  const mime = header?.split(";")[0]?.trim().toLowerCase();
  if (mime === expected) return true;
  // Storage serves HTML as text/plain so the storage host does not execute it.
  return expected === "text/html" && mime === "text/plain";
}
