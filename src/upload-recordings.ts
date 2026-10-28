import { attachmentDigest } from "../supabase/functions/_shared/attachments.mjs";
import { sourcesWithRecordingLocations } from "./recording-location.mjs";
import {
  UploadSchema,
  uploadDigest,
} from "../supabase/functions/_shared/upload.mjs";
import {
  isCloud,
  getSession,
  clearSession,
  CLOUD_API,
  SUPABASE_PUBLISHABLE_KEY,
} from "./cloud";
import {
  discardSession,
  recoverSession,
  listRecoverableSessions,
} from "./recording";
import {
  getDraft,
  saveDraft,
  listDrafts,
  freezeDraft,
  updateSubmission,
  deleteDraft,
  type AudioPart,
  type OfflineDraft,
  type UploadScope,
  type UploadIdentity,
  type UploadReceipt,
} from "./offline-store";
import type { Meeting } from "./types";
import {
  authenticationGeneration,
  assertAuthentication,
} from "./offline-authorization";

export class UploadError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
function credential() {
  return isCloud ? getSession()?.token || "" : "local";
}
async function request<T>(
  path: string,
  options: RequestInit = {},
  token = credential(),
  timeoutMs = 30_000,
): Promise<T> {
  if (!token || token !== credential())
    throw new UploadError(
      "ログイン情報が変わりました。同じアカウントで再ログインして手動再送してください。",
    );
  const generation = authenticationGeneration();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${isCloud ? CLOUD_API : "/api"}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "X-Kotonoha": "1",
        ...(options.body instanceof Blob || options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...(isCloud
          ? {
              Authorization: `Bearer ${token}`,
              apikey: SUPABASE_PUBLISHABLE_KEY,
            }
          : {}),
      },
    });
    if (token !== credential())
      throw new UploadError(
        "ログイン情報が変わったため送信を停止しました。原音は保持しています。",
      );
    if (!response.ok) {
      if (isCloud && response.status === 401) clearSession();
      let message = `送信を確認できません（HTTP ${response.status}）。`;
      try {
        const body = await response.json();
        if (typeof body.error === "string") message = body.error;
      } catch {
        /* HTTP status remains authoritative. */
      }
      throw new UploadError(
        message,
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
      );
    }
    try {
      const result = await response.json();
      assertAuthentication(generation);
      if (token !== credential())
        throw new UploadError("認証が変わりました。原音を保持しています。");
      return result;
    } catch (error) {
      if (
        controller.signal.aborted ||
        error instanceof TypeError ||
        (error as Error).name === "AbortError"
      )
        throw new UploadError(
          "保存応答の受信が途切れました。原音を保持して再開を待ちます。",
          true,
        );
      throw new UploadError(
        "サーバーの保存応答が不正です。原音を保持して停止しました。",
      );
    }
  } catch (e) {
    if (e instanceof UploadError) throw e;
    throw new UploadError(
      "通信が途切れました。端末内に保持し、待機後に同じ送信を再開します。",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}
function validScope(value: any): value is UploadScope {
  return (
    typeof value?.ownerId === "string" &&
    !!value.ownerId &&
    typeof value?.actorId === "string" &&
    !!value.actorId &&
    value.capabilities?.resumableUpload === 1
  );
}
function sameScope(a: UploadScope, b: UploadScope) {
  return a.ownerId === b.ownerId && a.actorId === b.actorId;
}
async function contextKey(token: string) {
  return `kotonoha-upload-context:${await attachmentDigest(new TextEncoder().encode(token))}`;
}
export async function getUploadContext(
  allowCached = true,
): Promise<UploadScope> {
  const generation = authenticationGeneration();
  const token = credential();
  const key = await contextKey(token);
  try {
    const scope = await request<UploadScope>("/uploads/context", {}, token);
    assertAuthentication(generation);
    if (!validScope(scope))
      throw new UploadError("保存先の認証応答が不正です。");
    try {
      sessionStorage.setItem(key, JSON.stringify(scope));
    } catch {
      /* Cache is optional; draft storage is not. */
    }
    return scope;
  } catch (e) {
    if (
      allowCached &&
      token === credential() &&
      generation === authenticationGeneration() &&
      e instanceof UploadError &&
      e.retryable
    ) {
      let cached;
      try {
        cached = JSON.parse(sessionStorage.getItem(key) || "null");
      } catch {
        /* No trustworthy cache. */
      }
      if (validScope(cached)) return cached;
    }
    throw e;
  }
}
// Local disclosure and deletion also require a fresh scope, never a cache.
export async function authorizeOfflineDraft(draft: OfflineDraft) {
  const generation = authenticationGeneration();
  const scope = await getUploadContext(false);
  assertAuthentication(generation);
  if (!sameScope(scope, draft.scope))
    throw new UploadError(
      "保存先またはアカウントが異なります。原音は保持しています。",
    );
  return () => assertAuthentication(generation);
}
export async function createOfflineDraft(): Promise<OfflineDraft> {
  const scope = await getUploadContext();
  const draft: OfflineDraft = {
    id: crypto.randomUUID(),
    scope,
    mode: "file",
    metadata: {
      title: "",
      date: new Date().toLocaleDateString("sv-SE"),
      participants: "",
      template: "standard",
    },
    transcript: "",
    files: [],
    attachments: [],
    sessionIds: [],
    updatedAt: Date.now(),
  };
  return saveDraft(draft);
}
async function prepareParts(
  files: File[],
  progress: (message: string) => void,
): Promise<AudioPart[]> {
  if (!files.length) return [];
  const worker = new Worker(new URL("./audio-worker.ts", import.meta.url), {
    type: "module",
  });
  progress("音声を確認し、自動分割しています…");
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.error) reject(new UploadError(data.error));
        else if (data.parts) resolve(data.parts);
        else if (data.progress)
          progress(
            `録音${data.progress.sourceIndex + 1}/${files.length}を準備中 ${Math.round(data.progress.ratio * 100)}%`,
          );
      };
      worker.onerror = () =>
        reject(new UploadError("音声を準備できません。原音を保持しています。"));
      worker.postMessage(files);
    });
  } finally {
    worker.terminate();
  }
}
function sameIdentity(value: any, expected: UploadIdentity) {
  return (
    value?.uploadId === expected.uploadId &&
    value?.ownerId === expected.ownerId &&
    value?.planDigest === expected.planDigest
  );
}
function checkedMeeting(
  value: any,
  draft: OfflineDraft,
): Meeting & { uploadReceipt?: UploadReceipt; uploadIdentity: UploadIdentity } {
  if (
    !value ||
    typeof value.id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.id) ||
    !sameIdentity(value.uploadIdentity, draft.attempt!.identity)
  )
    throw new UploadError(
      "送信ID・保存先・内容の一致を確認できません。原音を保持して停止しました。",
    );
  if (
    value.uploadReceipt !== undefined &&
    (!sameIdentity(value.uploadReceipt, draft.attempt!.identity) ||
      value.uploadReceipt.meetingId !== value.id ||
      value.uploadReceipt.status !== "accepted")
  )
    throw new UploadError(
      "保存証明が一致しません。原音を保持して停止しました。",
    );
  return value;
}
async function cleanup(draft: OfflineDraft) {
  const current = await authorizeOfflineDraft(draft);
  // Receipt is durable BEFORE crossing DBs. A crash here resumes cleanup only.
  if (
    !draft.receipt ||
    !draft.attempt ||
    !sameIdentity(draft.receipt, draft.attempt.identity)
  )
    throw new UploadError("保存証明がありません。");
  const others = (await listDrafts()).filter((d) => d.id !== draft.id);
  current();
  if (!Array.isArray(draft.attempt.sessionIds))
    throw new UploadError(
      "原本の関連付けを確認できません。端末内データを保持しています。",
    );
  const existing = await listRecoverableSessions();
  for (const id of draft.attempt.sessionIds)
    if (existing.some((s) => s.id === id)) await recoverSession(id);
  for (const id of draft.attempt.sessionIds) {
    if (!others.some((d) => d.sessionIds.includes(id))) {
      current();
      await discardSession(id, current);
    }
  }
  current();
  await deleteDraft(draft.id, current);
}
export async function discardOfflineDraft(id: string) {
  const draft = await getDraft(id);
  if (!draft) return;
  const current = await authorizeOfflineDraft(draft);
  const others = (await listDrafts()).filter((d) => d.id !== id);
  current();
  for (const session of draft.sessionIds)
    if (!others.some((d) => d.sessionIds.includes(session))) {
      current();
      await discardSession(session, current);
    }
  current();
  await deleteDraft(id, current);
}
async function resume(
  id: string,
  progress: (message: string) => void,
  timeoutMs?: number,
): Promise<Meeting | undefined> {
  let draft = await getDraft(id);
  if (!draft?.attempt) return;
  const generation = authenticationGeneration();
  if (draft.receipt) {
    await cleanup(draft);
    assertAuthentication(generation);
    return draft.acceptedMeeting as Meeting;
  }
  try {
    const token = credential();
    const scope = await getUploadContext(false);
    if (!sameScope(scope, draft.scope))
      throw new UploadError(
        "保存先またはアカウントが異なります。作成時と同じアカウントで手動再送してください。",
      );
    const call = <T>(path: string, options: RequestInit = {}) =>
      request<T>(path, options, token, timeoutMs);
    const attempt = draft.attempt;
    if (!Array.isArray(attempt.sessionIds))
      throw new UploadError(
        "原本の関連付けを確認できません。原音を保全しています。",
      );
    for (const session of attempt.sessionIds) await recoverSession(session);
    let meeting = checkedMeeting(
      await call("/uploads", {
        method: "POST",
        body: JSON.stringify(attempt.input),
      }),
      draft,
    );
    if (!meeting.uploadReceipt) {
      const recordings = meeting.recordings;
      if (
        meeting.status !== "uploading" ||
        !Array.isArray(recordings) ||
        recordings.length > attempt.parts.length ||
        !Array.isArray(meeting.attachments)
      )
        throw new UploadError(
          "途中保存の応答が不正です。原音を保持しています。",
        );
      for (let i = recordings.length; i < attempt.parts.length; i++) {
        progress(`音声を送信中 ${i + 1}/${attempt.parts.length}`);
        await call(`/meetings/${meeting.id}/parts?index=${i}`, {
          method: "POST",
          body: attempt.parts[i].blob,
        });
      }
      const existing = new Set(meeting.attachments.map((a) => a.id));
      for (const { file, id: attachmentId } of attempt.attachments) {
        if (existing.has(attachmentId)) continue;
        progress(`添付資料を保存中：${file.name}`);
        const form = new FormData();
        form.set("id", attachmentId);
        form.set("attachment", file);
        await call(`/meetings/${meeting.id}/attachments`, {
          method: "POST",
          body: form,
        });
      }
      meeting = checkedMeeting(
        await call(`/meetings/${meeting.id}/complete`, { method: "POST" }),
        draft,
      );
      if (!meeting.uploadReceipt)
        throw new UploadError(
          "保存完了の証明がありません。原音を保持しています。",
        );
    }
    await updateSubmission(id, {
      receipt: meeting.uploadReceipt,
      acceptedMeeting: meeting,
      status: "cleanup",
      error: "",
    });
    draft = (await getDraft(id))!;
    await cleanup(draft);
    assertAuthentication(generation);
    progress("サーバー保存を確認し、この送信の端末内データを削除しました。");
    return meeting;
  } catch (e) {
    const latest = await getDraft(id);
    if (latest) {
      const retryable = e instanceof UploadError && e.retryable;
      const retries = (latest.retries || 0) + 1;
      await updateSubmission(id, {
        status: latest.receipt ? "cleanup" : retryable ? "queued" : "blocked",
        error: (e as Error).message,
        retries,
        nextRetryAt:
          Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(retries - 1, 5)),
      });
    }
    throw e;
  }
}
export async function resumeOfflineDraft(
  id: string,
  progress: (message: string) => void = () => {},
  options: { timeoutMs?: number; automatic?: boolean } = {},
) {
  const locked = async () => {
    const latest = await getDraft(id);
    if (
      options.automatic &&
      (latest?.status === "blocked" || (latest?.nextRetryAt || 0) > Date.now())
    )
      return;
    return resume(id, progress, options.timeoutMs);
  };
  if (navigator.locks)
    return navigator.locks.request(`kotonoha-upload:${id}`, locked);
  return locked();
}
export async function uploadRecordings(
  data: FormData,
  progress: (message: string) => void,
) {
  const generation = authenticationGeneration();
  let id = String(data.get("_offlineDraftId") || "");
  let draft = id ? await getDraft(id) : undefined;
  if (id && !draft)
    throw new UploadError(
      "この下書きは送信済み、または別の画面で破棄されています。会議一覧を確認してください。新しい会議は作成していません。",
    );
  if (
    draft &&
    !draft.attempt &&
    (!data.has("_offlineDraftRevision") ||
      String(draft.revision || 0) !== data.get("_offlineDraftRevision"))
  )
    throw new UploadError(
      "別の画面で下書きが変更されています。最新の入力と原音を保全し、送信を停止しました。下書きを開き直してください。",
    );
  if (!draft) {
    draft = await createOfflineDraft();
    id = draft.id;
    draft = {
      ...draft,
      mode: data.get("transcript") ? "text" : "file",
      metadata: Object.fromEntries(
        ["title", "date", "participants", "template"].map((k) => [
          k,
          String(data.get(k) || ""),
        ]),
      ) as OfflineDraft["metadata"],
      transcript: String(data.get("transcript") || ""),
      files: data.getAll("audio") as File[],
      sourceLocations: sourcesWithRecordingLocations(
        data.getAll("audio"),
        data.get("recordingLocations"),
      ).map((source: any) => source.startLocation ?? null),
      attachments: data.getAll("attachment") as File[],
    };
    draft = await saveDraft(draft);
  }
  if (!draft.attempt) {
    await authorizeOfflineDraft(draft);
    if (draft.mode !== "text")
      for (const session of draft.sourceSessions || [])
        if (session) await recoverSession(session);
    const parts = await prepareParts(
      draft.mode === "text" ? [] : draft.files,
      progress,
    );
    const attachments = draft.attachments.map((file) => ({
      file,
      id: crypto.randomUUID(),
    }));
    const input = UploadSchema.parse({
      uploadId: crypto.randomUUID(),
      metadata: draft.metadata,
      sources:
        draft.mode === "text"
          ? []
          : sourcesWithRecordingLocations(
              draft.files,
              JSON.stringify(
                draft.files.map(
                  (_, index) => draft.sourceLocations?.[index] ?? null,
                ),
              ),
            ),
      transcript: draft.mode === "text" ? draft.transcript : "",
      attachments: await Promise.all(
        attachments.map(async ({ file, id }) => ({
          id,
          name: file.name,
          size: file.size,
          sha256: await attachmentDigest(await file.arrayBuffer()),
        })),
      ),
      parts: await Promise.all(
        parts.map(
          async ({ blob, name, sourceIndex, partNumber, duration }) => ({
            name,
            sourceIndex,
            partNumber,
            duration,
            size: blob.size,
            sha256: await attachmentDigest(await blob.arrayBuffer()),
          }),
        ),
      ),
    });
    assertAuthentication(generation);
    await freezeDraft(
      id,
      {
        input,
        identity: {
          uploadId: input.uploadId!,
          ownerId: draft.scope.ownerId,
          planDigest: await uploadDigest(input),
        },
        parts,
        attachments,
      },
      draft.revision || 0,
    );
  }
  const result = await resumeOfflineDraft(id, progress);
  assertAuthentication(generation);
  if (!result)
    throw new UploadError(
      "送信済み、または別の画面で処理されています。会議一覧を確認してください。",
    );
  return result;
}
