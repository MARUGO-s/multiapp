// In-browser meeting recorder: mic-only, or mic mixed with shared tab/window
// audio (for online meetings on desktop). Chunks are written to IndexedDB as
// they arrive so an unexpected tab close or crash loses at most a few
// seconds, not the whole recording.

import type { RecordingLocation } from "./types";
import {
  captureRecordingLocation,
  rememberRecordingLocation,
} from "./recording-location.mjs";
export type RecordingMode = "mic" | "mic+tab";

const DB_NAME = "kotonoha-recorder";
const DB_VERSION = 1;
const CHUNK_STORE = "chunks";
const SESSION_STORE = "sessions";

export interface RecordingSessionMeta {
  id: string;
  startedAt: number;
  mode: RecordingMode;
  mimeType: string;
  extension: string;
  draftId?: string;
  scope?: { ownerId: string; actorId: string };
  startLocation?: RecordingLocation;
  // Absence (legacy), interrupted recording, and failed sealing are UNKNOWN,
  // not evidence that the stored prefix is a complete original.
  integrity?: "recording" | "failed" | "complete";
  expectedChunks?: number;
  failedIndices?: number[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE))
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        const store = db.createObjectStore(CHUNK_STORE, { keyPath: "key" });
        store.createIndex("bySession", "sessionId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putChunk(sessionId: string, index: number, blob: Blob) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHUNK_STORE, "readwrite");
      tx.objectStore(CHUNK_STORE).put({
        key: `${sessionId}#${String(index).padStart(6, "0")}`,
        sessionId,
        index,
        blob,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          tx.error || new Error("端末内の録音保存・削除が中断されました。"),
        );
    });
  } finally {
    db.close();
  }
}

async function getChunks(
  sessionId: string,
): Promise<{ index: number; blob: Blob }[]> {
  const db = await openDb();
  try {
    const chunks = await new Promise<{ index: number; blob: Blob }[]>(
      (resolve, reject) => {
        const tx = db.transaction(CHUNK_STORE, "readonly");
        const req = tx
          .objectStore(CHUNK_STORE)
          .index("bySession")
          .getAll(sessionId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
    return chunks.sort((a, b) => a.index - b.index);
  } finally {
    db.close();
  }
}

async function deleteSession(
  sessionId: string,
  authorize: () => void = () => {},
) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      authorize();
      const tx = db.transaction([CHUNK_STORE, SESSION_STORE], "readwrite");
      const chunkStore = tx.objectStore(CHUNK_STORE);
      const range = tx.objectStore(CHUNK_STORE).index("bySession");
      const req = range.getAllKeys(sessionId);
      req.onsuccess = () => {
        try {
          authorize();
        } catch (error) {
          tx.abort();
          reject(error);
          return;
        }
        for (const key of req.result) chunkStore.delete(key as IDBValidKey);
      };
      tx.objectStore(SESSION_STORE).delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          tx.error || new Error("端末内の録音保存・削除が中断されました。"),
        );
    });
  } finally {
    db.close();
  }
}

async function putSessionMeta(meta: RecordingSessionMeta) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, "readwrite");
      tx.objectStore(SESSION_STORE).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          tx.error || new Error("端末内の録音保存・削除が中断されました。"),
        );
    });
  } finally {
    db.close();
  }
}

export async function listRecoverableSessions(): Promise<
  RecordingSessionMeta[]
> {
  const db = await openDb();
  try {
    const sessions = await new Promise<RecordingSessionMeta[]>(
      (resolve, reject) => {
        const tx = db.transaction(SESSION_STORE, "readonly");
        const req = tx.objectStore(SESSION_STORE).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
    return sessions;
  } finally {
    db.close();
  }
}

function fileName(meta: RecordingSessionMeta) {
  const d = new Date(meta.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `録音_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${meta.extension}`;
}

export async function recoverSession(id: string): Promise<File> {
  const sessions = await listRecoverableSessions();
  const meta = sessions.find((s) => s.id === id);
  if (!meta) throw new Error("録音が見つかりません。");
  const chunks = await getChunks(id);
  if (
    meta.integrity !== "complete" ||
    !Number.isInteger(meta.expectedChunks) ||
    !meta.expectedChunks ||
    meta.failedIndices?.length ||
    chunks.length !== meta.expectedChunks ||
    chunks.some((c, i) => c.index !== i || !c.blob.size)
  )
    throw new Error(
      "録音の完全性を確認できません（保存失敗・未完了または不完全な録音）。通常の取り込み・送信は停止し、端末内の原音を保全しています。画面を閉じず、元の録音機器・ファイルも保全してください。",
    );
  const file = new File(
    chunks.map((c) => c.blob),
    fileName(meta),
    { type: meta.mimeType },
  );
  rememberRecordingLocation(file, meta.startLocation);
  return file;
}

export async function discardSession(
  id: string,
  authorize: () => void = () => {},
) {
  await deleteSession(id, authorize);
}

export interface RecordingCapabilities {
  canRecordMic: boolean;
  canRecordMeeting: boolean;
}

// Covers phones and tablets alike (iPad, Android tablets included via the
// touch-pointer check), since both lose recording the same way when the
// browser is backgrounded.
export function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return true;
  return matchMedia("(pointer: coarse)").matches;
}

export function getRecordingCapabilities(): RecordingCapabilities {
  const hasMedia =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const hasDisplay =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getDisplayMedia;
  return {
    canRecordMic: hasMedia && typeof MediaRecorder !== "undefined",
    // Tab/window audio capture works reliably only on desktop browsers.
    // On phones it either doesn't exist or switches away to another app,
    // so we don't offer it there even if the API is technically present.
    canRecordMeeting: hasMedia && hasDisplay && !isMobileDevice(),
  };
}

function pickMimeType(): { mimeType: string; extension: string } {
  const candidates = [
    { mimeType: "audio/webm;codecs=opus", extension: ".webm" },
    { mimeType: "audio/webm", extension: ".webm" },
    { mimeType: "audio/mp4", extension: ".mp4" },
  ];
  for (const c of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(c.mimeType)
    )
      return c;
  }
  return { mimeType: "", extension: "" };
}

export interface RecorderController {
  sessionId: string;
  pause(): void;
  resume(): void;
  stop(): Promise<File>;
  cancel(): Promise<void>;
  getAnalyser(): AnalyserNode | null;
}

export async function startRecording(
  mode: RecordingMode,
  onTick: (seconds: number) => void,
  options: {
    draftId?: string;
    scope?: { ownerId: string; actorId: string };
    recordLocation?: boolean;
    onStorageError?: (error: Error) => void;
  } = {},
): Promise<RecorderController> {
  const picked = pickMimeType();
  if (!picked.mimeType)
    throw new Error("この端末・ブラウザーは録音に対応していません。");

  let micStream: MediaStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch {
    throw new Error(
      "マイクを使用できません。ブラウザーの設定でマイクへのアクセスを許可してください。",
    );
  }

  let displayStream: MediaStream | null = null;
  if (mode === "mic+tab") {
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch {
      micStream.getTracks().forEach((t) => t.stop());
      throw new Error(
        "画面/タブの共有がキャンセルされました。会議のタブを選び、「音声を共有」にチェックを入れてください。",
      );
    }
    if (!displayStream.getAudioTracks().length) {
      micStream.getTracks().forEach((t) => t.stop());
      displayStream.getTracks().forEach((t) => t.stop());
      throw new Error(
        "共有した画面/タブに音声がありません。会議が開いているタブを選び、「タブの音声を共有」にチェックを入れてやり直してください。",
      );
    }
    // We only need the audio; drop the video track immediately so nothing
    // is captured or encoded.
    displayStream.getVideoTracks().forEach((t) => t.stop());
  }

  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  destination.channelCount = 1;
  audioContext.createMediaStreamSource(micStream).connect(destination);
  if (displayStream)
    audioContext.createMediaStreamSource(displayStream).connect(destination);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  destination.stream.getAudioTracks().length &&
    audioContext.createMediaStreamSource(destination.stream).connect(analyser);

  const sessionId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const meta: RecordingSessionMeta = {
    id: sessionId,
    startedAt: Date.now(),
    mode,
    mimeType: picked.mimeType,
    extension: picked.extension,
    draftId: options.draftId,
    scope: options.scope,
    integrity: "recording",
    expectedChunks: 0,
    failedIndices: [],
  };
  try {
    await putSessionMeta(meta);
  } catch (error) {
    micStream.getTracks().forEach((t) => t.stop());
    displayStream?.getTracks().forEach((t) => t.stop());
    await audioContext.close();
    options.onStorageError?.(error as Error);
    throw error;
  }

  const recorder = new MediaRecorder(destination.stream, {
    mimeType: picked.mimeType,
    audioBitsPerSecond: 32_000,
  });
  let chunkIndex = 0;
  let pendingWrites = Promise.resolve();
  let storageError: Error | null = null;
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    const index = chunkIndex++;
    pendingWrites = pendingWrites.then(() =>
      putChunk(sessionId, index, e.data).catch((error: Error) => {
        storageError = error;
        meta.integrity = "failed";
        meta.expectedChunks = chunkIndex;
        meta.failedIndices!.push(index);
        options.onStorageError?.(error);
        // If even this write fails, the initial durable 'recording' sentinel
        // remains unsealed. It can never be recovered as a normal File.
        return putSessionMeta(meta).catch(() => {});
      }),
    );
  };
  recorder.start(4000);
  const cancelLocation = captureRecordingLocation({
    enabled: options.recordLocation === true,
    geolocation: navigator.geolocation,
    onLocation: (point: RecordingLocation) => {
      meta.startLocation = point;
      pendingWrites = pendingWrites.then(() =>
        putSessionMeta(meta).catch((error: Error) => {
          storageError = error;
          options.onStorageError?.(error);
        }),
      );
    },
  });

  let wakeLock: WakeLockSentinel | null = null;
  const requestWakeLock = async () => {
    try {
      wakeLock =
        (await (navigator as any).wakeLock?.request?.("screen")) ?? null;
    } catch {
      wakeLock = null;
    }
  };
  await requestWakeLock();
  const onVisibilityChange = () => {
    if (
      document.visibilityState === "visible" &&
      recorder.state === "recording"
    )
      requestWakeLock();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  let elapsedBeforePause = 0;
  let resumedAt = Date.now();
  const tick = () => {
    const running = recorder.state === "recording";
    const seconds = Math.floor(
      elapsedBeforePause + (running ? (Date.now() - resumedAt) / 1000 : 0),
    );
    onTick(seconds);
  };
  const interval = setInterval(tick, 1000);

  const cleanup = () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    wakeLock?.release().catch(() => {});
    micStream?.getTracks().forEach((t) => t.stop());
    displayStream?.getTracks().forEach((t) => t.stop());
    audioContext
      .close()
      .catch((e) => console.error("AudioContext close failed:", e));
  };
  let stopped: Promise<File> | null = null;

  return {
    getAnalyser: () => analyser,
    sessionId,
    pause() {
      if (recorder.state !== "recording") return;
      recorder.pause();
      elapsedBeforePause += (Date.now() - resumedAt) / 1000;
    },
    resume() {
      if (recorder.state !== "paused") return;
      resumedAt = Date.now();
      recorder.resume();
    },
    stop() {
      cancelLocation();
      if (stopped) return stopped;
      stopped = new Promise<File>((resolve, reject) => {
        recorder.onstop = async () => {
          cleanup();
          try {
            await pendingWrites;
            if (storageError) throw storageError;
            meta.integrity = "complete";
            meta.expectedChunks = chunkIndex;
            await putSessionMeta(meta);
            resolve(await recoverSession(sessionId));
          } catch (e) {
            reject(e as Error);
          }
        };
        if (recorder.state === "inactive") recorder.onstop(new Event("stop"));
        else recorder.stop();
      });
      return stopped;
    },
    async cancel() {
      cancelLocation();
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        if (recorder.state === "inactive") resolve();
        else recorder.stop();
      });
      cleanup();
      await pendingWrites;
      await deleteSession(sessionId);
    },
  };
}
