import { useEffect, useRef, useState } from "react";
import { OFFLINE_EVENT, listDrafts, type OfflineDraft } from "./offline-store";
import {
  resumeOfflineDraft,
  discardOfflineDraft,
  getUploadContext,
  authorizeOfflineDraft,
} from "./upload-recordings";
import {
  authenticationGeneration,
  assertAuthentication,
  useAuthenticationGeneration,
} from "./offline-authorization";
import { download } from "./api";
import { recoverSession } from "./recording";
import type { Meeting } from "./types";
import "./offline.css";

type Props = {
  onOpen: (id: string) => void;
  onAccepted: (meeting: Meeting) => void;
};
export function OfflineQueue(props: Props) {
  const generation = useAuthenticationGeneration();
  return <ScopedQueue key={generation} {...props} generation={generation} />;
}
function ScopedQueue({
  onOpen,
  onAccepted,
  generation,
}: Props & { generation: number }) {
  const [drafts, setDrafts] = useState<OfflineDraft[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string[]>([]);
  const live = useRef(true);
  const running = useRef(new Set<string>());
  const callbacks = useRef({ onAccepted });
  callbacks.current = { onAccepted };
  function current() {
    assertAuthentication(generation);
    if (!live.current)
      throw new Error("画面を閉じました。原音は保持しています。");
  }
  async function refresh() {
    try {
      const scope = await getUploadContext(false);
      const all = await listDrafts();
      current();
      const own = all.filter(
        (d) =>
          d.scope.ownerId === scope.ownerId &&
          d.scope.actorId === scope.actorId,
      );
      setDrafts(own);
      return own;
    } catch (e) {
      if (live.current && generation === authenticationGeneration()) {
        setDrafts([]);
        setError(
          "保存先の認証を確認できません。端末内の原音は保持しています。",
        );
      }
      return [];
    }
  }
  async function send(id: string, automatic = false) {
    if (running.current.has(id)) return;
    running.current.add(id);
    setBusy([...running.current]);
    try {
      current();
      const meeting = await resumeOfflineDraft(id, undefined, { automatic });
      current();
      if (meeting) {
        setError("");
        callbacks.current.onAccepted(meeting);
      }
    } catch (e) {
      if (live.current && generation === authenticationGeneration())
        setError((e as Error).message);
    } finally {
      running.current.delete(id);
      if (live.current && generation === authenticationGeneration()) {
        setBusy([...running.current]);
        await refresh();
      }
    }
  }
  useEffect(() => {
    live.current = true;
    const tick = async () => {
      const own = await refresh();
      if (!live.current || generation !== authenticationGeneration()) return;
      for (const d of own)
        if (
          d.attempt &&
          d.status !== "blocked" &&
          (d.nextRetryAt || 0) <= Date.now()
        )
          void send(d.id, true);
    };
    const wake = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const changed = () => {
      void refresh();
    };
    void tick();
    const timer = setInterval(wake, 1000);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener(OFFLINE_EVENT, changed);
    return () => {
      live.current = false;
      clearInterval(timer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener(OFFLINE_EVENT, changed);
    };
  }, []);
  async function originals(draft: OfflineDraft) {
    try {
      const authorized = await authorizeOfflineDraft(draft);
      current();
      for (const id of draft.sessionIds) {
        const file = await recoverSession(id);
        authorized();
        current();
        download(file.name, file, file.type);
      }
      for (const [i, file] of draft.files.entries())
        if (!draft.sourceSessions?.[i]) {
          authorized();
          current();
          download(file.name, file, file.type);
        }
    } catch (e) {
      if (live.current && generation === authenticationGeneration())
        setError((e as Error).message);
    }
  }
  async function open(draft: OfflineDraft) {
    try {
      await authorizeOfflineDraft(draft);
      current();
      onOpen(draft.id);
    } catch {
      if (live.current && generation === authenticationGeneration()) {
        setDrafts([]);
        setError("保存先の認証を確認できません。原音は保持しています。");
      }
    }
  }
  if (generation !== authenticationGeneration() || (!drafts.length && !error))
    return null;
  return (
    <section className="offline-queue" aria-label="端末内の下書き・送信待ち">
      <h2>端末内の下書き・送信待ち</h2>
      <small>
        送信依頼済みだけを再開します。別アカウントへは送信しません。保存証明と現在の保存先の確認後に対象の端末内データを自動削除します。
      </small>
      {drafts.map((d) => (
        <div className="offline-draft" key={d.id}>
          <span>
            <strong>{d.metadata.title || "無題の下書き"}</strong>
            <small>
              {busy.includes(d.id)
                ? "再開中…"
                : d.receipt
                  ? "サーバー保存済み・端末内削除待ち"
                  : d.status === "blocked"
                    ? "要確認・自動再送停止"
                    : d.attempt
                      ? "送信待ち・通信復旧後に再開"
                      : "編集中・未送信"}
            </small>
            {d.error && <small role="status">{d.error}</small>}
          </span>
          {!d.attempt && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => void open(d)}
            >
              編集を再開
            </button>
          )}
          {d.attempt && (
            <button
              type="button"
              className="button secondary small"
              disabled={busy.includes(d.id)}
              onClick={() => void send(d.id)}
            >
              {d.receipt ? "端末内削除を再実行" : "手動再送"}
            </button>
          )}
          {(d.files.length > 0 || d.sessionIds.length > 0) && (
            <button
              type="button"
              className="text-button"
              onClick={() => void originals(d)}
            >
              原音をダウンロード
            </button>
          )}
          <button
            type="button"
            className="text-button"
            disabled={busy.includes(d.id)}
            onClick={async () => {
              try {
                await authorizeOfflineDraft(d);
                current();
                if (
                  !confirm(
                    "この下書きと関連する端末内録音を破棄しますか？サーバー側の会議は削除しません。",
                  )
                )
                  return;
                current();
                await discardOfflineDraft(d.id);
                current();
                await refresh();
              } catch (e) {
                if (live.current && generation === authenticationGeneration())
                  setError((e as Error).message);
              }
            }}
          >
            破棄
          </button>
        </div>
      ))}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
