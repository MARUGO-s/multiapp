import {
  fileSpecification,
  matchesFileSignature,
} from "../_shared/qr-files.mjs";
import { storeNamePayload } from "../_shared/qr-store-name.mjs";
import { validateLogoId } from "../_shared/qr-logos.mjs";

export class FileError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Rpc = (name: string, args: unknown) => Promise<any>;
const bucket = "marugo-qr-files";
function credentials() {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key)
    throw new FileError(503, "ファイル保存先が設定されていません。");
  return { base, key };
}
async function storage(path: string, init: RequestInit = {}) {
  const { base, key } = credentials();
  return await fetch(`${base}/storage/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20000),
  });
}
async function signed(path: string, upload = false, download?: string) {
  const response = await storage(
    `object/${upload ? "upload/sign" : "sign"}/${bucket}/${path}`,
    {
      method: "POST",
      body: JSON.stringify(
        upload ? {} : { expiresIn: 300, ...(download ? { download } : {}) },
      ),
    },
  );
  if (!response.ok)
    throw new FileError(
      503,
      "ファイルのリンクを準備できませんでした。再試行してください。",
    );
  const data = await response.json();
  const relative = data.url ?? data.signedURL;
  if (typeof relative !== "string" || !relative.startsWith("/"))
    throw new FileError(503, "ファイルのリンクを確認できませんでした。");
  const url = new URL(`${credentials().base}/storage/v1${relative}`);
  if (download) url.searchParams.set("download", download);
  return url.href;
}
async function verified(file: any) {
  // Both DB ownership and server-side object metadata are checked before publish.
  const response = await storage(
    `object/authenticated/${bucket}/${file.path}`,
    { headers: { Range: "bytes=0-31" } },
  );
  if (!response.ok || !response.body)
    throw new FileError(
      409,
      "アップロードを確認できませんでした。同じファイルで再試行してください。",
    );
  const total =
    response.headers.get("content-range")?.split("/").at(-1) ??
    response.headers.get("content-length");
  const mime = response.headers.get("content-type")?.split(";")[0];
  const reader = response.body.getReader();
  const prefix = new Uint8Array(32);
  let offset = 0;
  try {
    while (offset < prefix.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const count = Math.min(value.length, prefix.length - offset);
      prefix.set(value.subarray(0, count), offset);
      offset += count;
    }
  } finally {
    await reader.cancel();
  }
  if (
    Number(total) !== Number(file.size) ||
    mime !== file.mime ||
    !matchesFileSignature(file.mime, prefix.subarray(0, offset))
  )
    throw new FileError(
      400,
      "ファイルの内容・種類・サイズが一致しません。正しいPDF・JPG・PNGを選択してください。",
    );
}
export async function publicFile(code: string, rpc: Rpc) {
  const file = await rpc("kotonoha_qr_file", {
    p_operation: "public",
    p_payload: { code },
  });
  const url = await signed(file.path);
  const downloadUrl = await signed(file.path, false, file.file_name);
  return {
    fileName: file.file_name,
    title: file.title,
    mime: file.mime,
    size: file.size,
    url,
    downloadUrl,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  };
}
export async function prepareFile(
  input: Record<string, unknown>,
  owner: string,
  rpc: Rpc,
) {
  if (input.publishConfirmed !== true)
    throw new FileError(400, "一般公開の確認が必要です。");
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.trim().length > 120
  )
    throw new FileError(400, "管理用の名前を120文字以内で入力してください。");
  let spec;
  try {
    spec = fileSpecification(input.fileName, input.size);
  } catch (e) {
    throw new FileError(400, (e as Error).message);
  }
  const file = await rpc("kotonoha_qr_file", {
    p_operation: "init",
    p_owner: owner,
    p_id: input.id,
    p_payload: {
      title: input.title.trim(),
      ...spec,
      logoId: validateLogoId(input.logoId),
      ...storeNamePayload(input),
    },
  });
  if (file.link) return { link: file.link };
  // A retry after an uncertain upload skips the upload if a valid object exists.
  try {
    await verified(file);
    return { uploaded: true };
  } catch (e) {
    if (!(e instanceof FileError) || e.status !== 409) throw e;
  }
  return { uploadUrl: await signed(file.path, true), mime: file.mime };
}
export async function completeFile(id: string, owner: string, rpc: Rpc) {
  const file = await rpc("kotonoha_qr_file", {
    p_operation: "get",
    p_owner: owner,
    p_id: id,
  });
  if (!file) throw new FileError(404, "アップロードの準備が見つかりません。");
  if (file.state !== "ready") await verified(file);
  const code = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(9))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return await rpc("kotonoha_qr_file", {
    p_operation: "complete",
    p_owner: owner,
    p_id: id,
    p_payload: {
      code,
      targetUrl: `https://marugo-s.github.io/multiapp/?file=${code}`,
    },
  });
}
export async function removeFile(
  id: string,
  owner: string,
  rpc: Rpc,
  pendingOnly = false,
) {
  if (pendingOnly) {
    const file = await rpc("kotonoha_qr_file", {
      p_operation: "get",
      p_owner: owner,
      p_id: id,
    });
    if (!file) return;
    if (file.link_id)
      throw new FileError(
        409,
        "公開済みファイルはQRをゴミ箱へ移動してから完全削除してください。",
      );
  }
  const file = await rpc("kotonoha_qr_file", {
    p_operation: "begin_purge",
    p_owner: owner,
    p_id: id,
    p_payload: { confirmId: id },
  });
  if (!file) return;
  const response = await storage(`object/${bucket}`, {
    method: "DELETE",
    body: JSON.stringify({ prefixes: [file.path] }),
  });
  if (!response.ok)
    throw new FileError(
      503,
      "ファイルの削除を確認できませんでした。ゴミ箱で再度完全削除してください。削除完了まで復元はできません。",
    );
  await rpc("kotonoha_qr_file", {
    p_operation: "removed",
    p_owner: owner,
    p_id: id,
  });
}
