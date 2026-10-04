import React, { useEffect, useRef, useState } from "react";
import {
  changeDirectoryAccess,
  getDirectoryHistory,
  directoryApps,
  directoryStatuses,
  type DirectoryRow,
  type DirectoryChange,
  type DirectoryHistory,
} from "./directory-client";
import { canBatch, changeOutcome } from "./directory-approval-policy.mjs";

type Item = {
  row: DirectoryRow;
  request: DirectoryChange;
  state: "waiting" | "success" | "unknown" | "rejected";
  message: string;
};
export function DirectoryApprovals({
  rows,
  actor,
  onChanged,
}: {
  rows: DirectoryRow[];
  actor: string;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [action, setAction] = useState<"approve" | "suspend">("approve");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [history, setHistory] = useState<DirectoryHistory | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [historyBusy, setHistoryBusy] = useState(false);
  const alive = useRef(true),
    sending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const candidates = rows.filter((r) => r.control?.actions.length);
  const chosen = candidates.filter((r) => selected.includes(r.key));
  useEffect(() => {
    setSelected((old) =>
      old.filter((k) =>
        rows.some((r) => r.key === k && r.control?.actions.length),
      ),
    );
  }, [rows]);
  function prepare(next: "approve" | "suspend") {
    if (!canBatch(chosen, next) || sending.current) return;
    setAction(next);
    setReason("");
    setStarted(false);
    setItems(
      chosen.map((row) => ({
        row,
        request: {
          key: row.key,
          version: row.control!.version,
          action: next,
          reason: "",
          requestId: crypto.randomUUID(),
        },
        state: "waiting",
        message: "",
      })),
    );
    dialog.current?.showModal();
  }
  async function execute(retry = false) {
    if (sending.current || (!retry && !reason.trim())) return;
    sending.current = true;
    setBusy(true);
    setStarted(true);
    const batch = items.map((i) => ({
      ...i,
      request: retry ? i.request : { ...i.request, reason: reason.trim() },
    }));
    setItems([...batch]);
    for (const item of batch) {
      if (!alive.current) break;
      if (retry ? item.state !== "unknown" : item.state !== "waiting") continue;
      try {
        const result = await changeDirectoryAccess(actor, item.request);
        if (
          !result.ok ||
          result.key !== item.request.key ||
          result.requestId !== item.request.requestId
        )
          throw new Error("操作結果を確認できません。");
        item.state = "success";
        item.message =
          "完了（" + (directoryStatuses[result.status] || result.status) + "）";
      } catch (error) {
        const status = (error as { status?: number }).status;
        item.state =
          retry && (status === 401 || status === 403)
            ? "unknown"
            : changeOutcome(error);
        item.message =
          item.state === "unknown"
            ? "結果未確認。同じ操作番号で再確認してください。"
            : error instanceof Error
              ? error.message
              : "操作できませんでした。";
        if (
          (error as { status?: number }).status === 401 ||
          (error as { status?: number }).status === 403
        ) {
          for (const rest of batch)
            if (rest !== item && rest.state === "waiting") {
              rest.state = "rejected";
              rest.message = "認証・権限の確認が必要なため、未送信です。";
            }
          if (alive.current) setItems(batch.map((i) => ({ ...i })));
          break;
        }
      }
      if (alive.current) setItems(batch.map((i) => ({ ...i })));
    }
    sending.current = false;
    if (alive.current) {
      setBusy(false);
      setSelected([]);
      setHistory(null);
      onChanged();
    }
  }
  async function loadHistory(more = false) {
    if (historyBusy) return;
    setHistoryBusy(true);
    setHistoryError("");
    try {
      const page = await getDirectoryHistory(
        more ? (history?.nextOffset ?? 0) : 0,
      );
      if (alive.current)
        setHistory((old) => ({
          ...page,
          rows: more ? [...(old?.rows ?? []), ...page.rows] : page.rows,
        }));
    } catch (error) {
      if (alive.current)
        setHistoryError(
          error instanceof Error ? error.message : "履歴を取得できません。",
        );
    } finally {
      if (alive.current) setHistoryBusy(false);
    }
  }
  return (
    <section className="dir-approvals" aria-labelledby="approval-title">
      <div className="dir-source-heading">
        <div>
          <p className="dir-eyebrow">ACCESS REQUESTS</p>
          <h2 id="approval-title">申請・利用権限の管理</h2>
        </div>
        <span>kotonoha / MARUGO QR</span>
      </div>
      <p>
        各アプリで受け付けた申請を表示します。下の一覧から最大20件を選び、まとめて承認・承認取り消しできます。管理者の役割変更・アカウント削除は行いません。
      </p>
      <p className="dir-explainer">
        検索条件に一致する、取得済みの対象だけを表示しています。レシピ・SNS・グルメ・LINE・M-talk・Journalは、この承認操作にはまだ対応していません。
      </p>
      <div className="dir-approval-toolbar">
        <strong>{chosen.length}件選択</strong>
        <button
          className="dir-secondary"
          disabled={busy || !candidates.length}
          onClick={() =>
            setSelected(
              candidates
                .filter(
                  (r) =>
                    r.status === "pending" &&
                    r.control?.actions.includes("approve"),
                )
                .slice(0, 20)
                .map((r) => r.key),
            )
          }
        >
          承認待ちを選択（最大20件）
        </button>
        <button
          disabled={busy || !canBatch(chosen, "approve")}
          onClick={() => prepare("approve")}
        >
          承認・再承認
        </button>
        <button
          className="dir-danger"
          disabled={busy || !canBatch(chosen, "suspend")}
          onClick={() => prepare("suspend")}
        >
          承認取り消し・申請を停止
        </button>
        <button
          className="dir-secondary"
          disabled={busy || !chosen.length}
          onClick={() => setSelected([])}
        >
          選択解除
        </button>
      </div>
      <div className="dir-approval-list">
        {candidates.map((row) => (
          <label key={row.key} className="dir-approval-row">
            <input
              type="checkbox"
              checked={selected.includes(row.key)}
              disabled={
                busy || (!selected.includes(row.key) && chosen.length >= 20)
              }
              onChange={(e) =>
                setSelected((old) =>
                  e.target.checked
                    ? [...old, row.key]
                    : old.filter((k) => k !== row.key),
                )
              }
            />
            <span>
              <strong>{row.name || row.email || "名称なし"}</strong>
              <small>
                {row.email} · {directoryApps[row.app_id]} ·{" "}
                {row.affiliation || "所属の記録なし"}
              </small>
              <small>{row.control?.scope}</small>
            </span>
            <span className={"dir-badge dir-status-" + row.status}>
              {directoryStatuses[row.status]}
            </span>
          </label>
        ))}
        {!candidates.length && (
          <p>現在の検索結果に、操作可能な申請・利用権限はありません。</p>
        )}
      </div>
      <details>
        <summary>この管理画面での操作履歴</summary>
        <p>
          操作者ID・対象ID・変更前後・理由を保存します。各アプリ内で直接行った操作は含みません。
        </p>
        <button
          className="dir-secondary"
          disabled={historyBusy}
          onClick={() => void loadHistory()}
        >
          履歴を取得・更新
        </button>
        {historyError && (
          <p role="alert" className="dir-error">
            {historyError}
          </p>
        )}
        {history && (
          <ol className="dir-history">
            {history.rows.map((h) => (
              <li key={h.id}>
                <strong>
                  {h.action === "approve" ? "承認" : "承認取り消し・停止"}
                </strong>{" "}
                · {new Date(h.created_at).toLocaleString("ja-JP")}
                <small>
                  対象：{h.target_key}
                  <br />
                  {directoryStatuses[h.before_status] || h.before_status} →{" "}
                  {directoryStatuses[h.after_status] || h.after_status}
                  <br />
                  理由：{h.reason}
                  <br />
                  操作者：{h.actor_id}
                </small>
              </li>
            ))}
          </ol>
        )}
        {history && !history.rows.length && (
          <p>この画面での操作履歴はまだありません。</p>
        )}
        {history?.nextOffset != null && (
          <button
            disabled={historyBusy}
            className="dir-secondary"
            onClick={() => void loadHistory(true)}
          >
            次の50件
          </button>
        )}
      </details>
      <dialog
        ref={dialog}
        className="dir-confirm"
        onCancel={(e) => {
          if (busy || items.some((i) => i.state === "unknown"))
            e.preventDefault();
        }}
      >
        <h2>
          {action === "approve"
            ? "利用を承認しますか？"
            : "承認を取り消し・停止しますか？"}
        </h2>
        <p>
          対象は{items.length}
          件です。1件ずつ処理するため、一部だけ完了する場合があります。
        </p>
        <ul>
          {items.map((item) => (
            <li key={item.row.key}>
              <strong>
                {item.row.name || item.row.email || item.row.user_id}
              </strong>
              <small>
                {item.row.email} · {directoryApps[item.row.app_id]} ·{" "}
                {item.row.affiliation}
              </small>
              <small>{item.row.control?.scope}</small>
              {started && (
                <p
                  role="status"
                  className={item.state === "unknown" ? "dir-warning" : ""}
                >
                  {item.state === "waiting" ? "待機中" : item.message}
                </p>
              )}
              {item.state === "unknown" && (
                <small>操作番号：{item.request.requestId}</small>
              )}
            </li>
          ))}
        </ul>
        <label>
          操作理由（必須）
          <textarea
            maxLength={500}
            value={reason}
            disabled={started}
            onChange={(e) => setReason(e.target.value)}
            placeholder="所属を確認したため／退職に伴う利用停止など"
          />
        </label>
        {!started && (
          <button
            disabled={busy || !reason.trim()}
            onClick={() => void execute()}
          >
            確認した{items.length}件を実行
          </button>
        )}
        {items.some((i) => i.state === "unknown") && (
          <>
            <p className="dir-warning">
              保存済みの可能性があります。この画面を閉じずに再確認してください。再確認は同じ操作番号を使い、重複して変更しません。
            </p>
            <button disabled={busy} onClick={() => void execute(true)}>
              結果未確認の操作を再確認
            </button>
          </>
        )}
        <button
          className="dir-secondary"
          disabled={busy || items.some((i) => i.state === "unknown")}
          onClick={() => dialog.current?.close()}
        >
          {started ? "閉じる" : "キャンセル"}
        </button>
        {busy && (
          <p role="status">
            操作中です。アカウントの切り替えやページ移動をしないでください。
          </p>
        )}
      </dialog>
    </section>
  );
}
