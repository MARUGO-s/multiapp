// Local-only outbox. A readwrite transaction is the commit boundary: request
// success alone is not durability (quota and abort can arrive afterwards).
export type UploadScope = { ownerId: string; actorId: string };
export type UploadIdentity = {
  uploadId: string;
  ownerId: string;
  planDigest: string;
};
export type UploadReceipt = UploadIdentity & {
  meetingId: string;
  status: "accepted";
};
export type AudioPart = {
  blob: Blob;
  name: string;
  sourceIndex: number;
  partNumber: number;
  duration: number;
};
export type FrozenAttempt = {
  input: any;
  identity: UploadIdentity;
  parts: AudioPart[];
  attachments: { file: File; id: string }[];
  // Immutable original ownership, independent of future draft edits.
  sessionIds?: string[];
};
export type OfflineDraft = {
  id: string;
  revision?: number;
  scope: UploadScope;
  mode: "file" | "record" | "text" | "bot";
  meetUrl?: string;
  recordLocation?: boolean;
  recordingMode?: "mic" | "mic+tab";
  selectedTemplateId?: string;
  metadata: {
    title: string;
    date: string;
    participants: string;
    template: string;
  };
  transcript: string;
  files: File[];
  attachments: File[];
  // Original session associations remain independent of transformed audio.
  sessionIds: string[];
  sourceSessions?: (string | null)[];
  sourceLocations?: unknown[];
  updatedAt: number;
  attempt?: FrozenAttempt;
  receipt?: UploadReceipt;
  acceptedMeeting?: unknown;
  status?: "queued" | "blocked" | "cleanup";
  error?: string;
  retries?: number;
  nextRetryAt?: number;
};
export const OFFLINE_EVENT = "kotonoha-offline-change";
const DB = "kotonoha-offline";
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("drafts"))
        req.result.createObjectStore("drafts", { keyPath: "id" });
      // ID-only tombstones prevent stale editors from resurrecting sent drafts.
      // No audio, metadata, attachments or upload payload survives cleanup.
      if (!req.result.objectStoreNames.contains("closed"))
        req.result.createObjectStore("closed", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error || new Error("端末内保存を開けません。"));
    req.onblocked = () =>
      reject(new Error("別の画面が端末内保存を使用中です。"));
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (
    store: IDBObjectStore,
    result: (value: T) => void,
    closed: IDBObjectStore,
  ) => void,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["drafts", "closed"], mode);
      let value: T;
      tx.oncomplete = () => {
        if (mode === "readwrite")
          window.dispatchEvent(new Event(OFFLINE_EVENT));
        resolve(value);
      };
      tx.onerror = tx.onabort = () =>
        reject(
          tx.error ||
            new Error("端末内保存が中断されました。録音は削除していません。"),
        );
      try {
        run(
          tx.objectStore("drafts"),
          (v) => {
            value = v;
          },
          tx.objectStore("closed"),
        );
      } catch (e) {
        tx.abort();
        reject(e);
      }
    });
  } finally {
    db.close();
  }
}
export function getDraft(id: string): Promise<OfflineDraft | undefined> {
  return transaction("readonly", (store, done) => {
    const req = store.get(id);
    req.onsuccess = () => done(req.result);
  });
}
export function listDrafts(): Promise<OfflineDraft[]> {
  return transaction("readonly", (store, done) => {
    const req = store.getAll();
    req.onsuccess = () => done(req.result);
  });
}
export function saveDraft(draft: OfflineDraft): Promise<OfflineDraft> {
  return transaction("readwrite", (store, done, closed) => {
    const tombstone = closed.get(draft.id);
    tombstone.onsuccess = () => {
      if (tombstone.result) {
        tombstone.transaction!.abort();
        return;
      }
      const req = store.get(draft.id);
      req.onsuccess = () => {
        // An old render / another tab must never overwrite a frozen submission.
        if (
          req.result?.attempt ||
          (req.result?.revision || 0) !== (draft.revision || 0)
        ) {
          req.transaction!.abort();
          return;
        }
        const next = { ...draft, revision: (draft.revision || 0) + 1 };
        store.put(next);
        done(next);
      };
    };
  });
}
export function freezeDraft(
  id: string,
  attempt: FrozenAttempt,
  expectedRevision: number,
): Promise<OfflineDraft> {
  return transaction("readwrite", (store, done) => {
    const req = store.get(id);
    req.onsuccess = () => {
      if (!req.result) {
        req.transaction!.abort();
        return;
      }
      const draft: OfflineDraft = req.result;
      if (!draft.attempt) {
        if (
          !Number.isInteger(expectedRevision) ||
          (draft.revision || 0) !== expectedRevision
        ) {
          req.transaction!.abort();
          return;
        }
        // A mode switch is not consent to discard the audio left on the file tab.
        // Keep it in a separate unsent draft in the SAME atomic freeze commit.
        if (
          draft.mode === "text" &&
          (draft.files.length || draft.sessionIds.length)
        ) {
          store.put({
            ...draft,
            id: crypto.randomUUID(),
            mode: "file",
            attachments: [],
            transcript: "",
            updatedAt: Date.now(),
          });
          draft.files = [];
          draft.sourceSessions = [];
          draft.sourceLocations = [];
          draft.sessionIds = [];
        } else if (draft.sourceSessions) {
          draft.sessionIds = [
            ...new Set(draft.sourceSessions.filter((s): s is string => !!s)),
          ];
        }
        draft.attempt = { ...attempt, sessionIds: [...draft.sessionIds] };
        draft.status = "queued";
        store.put(draft);
      }
      done(draft);
    };
  });
}
export function updateSubmission(
  id: string,
  patch: Partial<
    Pick<
      OfflineDraft,
      | "receipt"
      | "acceptedMeeting"
      | "status"
      | "error"
      | "retries"
      | "nextRetryAt"
    >
  >,
): Promise<void> {
  return transaction("readwrite", (store, done) => {
    const req = store.get(id);
    req.onsuccess = () => {
      if (!req.result?.attempt) {
        req.transaction!.abort();
        return;
      }
      store.put({ ...req.result, ...patch });
      done(undefined);
    };
  });
}
export function deleteDraft(
  id: string,
  authorize: () => void = () => {},
): Promise<void> {
  return transaction("readwrite", (store, done, closed) => {
    authorize();
    closed.put({ id });
    store.delete(id);
    done(undefined);
  });
}
