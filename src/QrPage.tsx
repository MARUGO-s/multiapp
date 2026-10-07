import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import QRCode from "qrcode";
import {
  ArrowDownToLine,
  Copy,
  LoaderCircle,
  Pause,
  Play,
  QrCode,
  RefreshCw,
  Trash2,
  RotateCcw,
  X,
} from "lucide-react";
import { useQrApi, type QrHistory, type QrLink, trackingUrl } from "./qr-api";
import { isCloud } from "./cloud";
import { QrAnalytics } from "./QrAnalytics";
import { QrFileUpload } from "./QrFileUpload";
import { Modal } from "./Modal";
import { lifecycleRequest } from "./qr-lifecycle.mjs";
import {
  sourceLabels,
  deviceLabels,
  browserLabels,
  buttonHtml,
} from "./qr-labels.mjs";

const dateTime = (value: string) =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "通信結果を確認できませんでした。";

export function QrPage({
  notify,
  onBusyChange,
  workspaceView,
}: {
  notify: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
  workspaceView?: "active" | "trash";
}) {
  const qrApi = useQrApi();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [links, setLinks] = useState<QrLink[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<"active" | "trash">("active");
  const [createMode, setCreateMode] = useState<"file" | "link">("file");
  useEffect(() => {
    if (workspaceView === undefined || workspaceView === view) return;
    setView(workspaceView);
    setPage(0);
    setLinks([]);
    setTotal(0);
    setLoading(true);
    setSelected(null);
    setError("");
  }, [workspaceView, view]);
  const [confirmation, setConfirmation] = useState<{
    action: "trash" | "purge";
    link: QrLink;
  } | null>(null);
  const [permanentConfirmed, setPermanentConfirmed] = useState(false);
  const [actionError, setActionError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<QrLink | null>(null);
  const [qr, setQr] = useState("");
  const [qrError, setQrError] = useState("");
  const [history, setHistory] = useState<QrHistory | null>(null);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyError, setHistoryError] = useState("");
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const createRequest = useRef<{
    id: string;
    title: string;
    targetUrl: string;
  } | null>(null);
  const mounted = useRef(true);
  const currentPage = useRef(page);
  const currentView = useRef(view);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const listRequest = useRef(0);
  currentPage.current = page;
  currentView.current = view;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const requestedPage = page;
    const requestedView = view;
    const requestId = ++listRequest.current;
    const current = () =>
      mounted.current &&
      currentPage.current === requestedPage &&
      currentView.current === requestedView &&
      listRequest.current === requestId;
    try {
      const data = await qrApi<{ links: QrLink[]; total: number }>(
        `/links?page=${page}&view=${view}`,
      );
      if (!current()) return;
      if (page > 0 && page * 50 >= data.total) {
        setPage(Math.max(0, Math.ceil(data.total / 50) - 1));
        return;
      }
      setLinks(data.links);
      setTotal(data.total);
      setError("");
      setSelected((prev) =>
        prev ? data.links.find((link) => link.id === prev.id) || null : null,
      );
    } catch (e) {
      if (current()) setError(errorText(e));
    } finally {
      if (current()) setLoading(false);
    }
  }, [page, view, qrApi]);
  useEffect(() => {
    if (!isCloud) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    setQr("");
    setQrError("");
    if (selected) {
      QRCode.toDataURL(trackingUrl(selected.code, "qr"), {
        width: 640,
        margin: 4,
        errorCorrectionLevel: "M",
      })
        .then((value) => {
          if (alive) setQr(value);
        })
        .catch(() => {
          if (alive) {
            setQrError(
              "QR画像を生成できませんでした。別のリンクを選ぶか画面を開き直してください。",
            );
          }
        });
    }
    return () => {
      alive = false;
    };
  }, [selected?.code]);
  useEffect(() => {
    let alive = true;
    setHistory(null);
    setHistoryError("");
    if (!selected) return;
    const load = () =>
      qrApi<QrHistory>(`/links/${selected.id}/history?page=${historyPage}`)
        .then((value) => {
          if (alive) {
            setHistory(value);
            setHistoryError("");
          }
        })
        .catch((e) => {
          if (alive) setHistoryError(errorText(e));
        });
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selected?.id, historyPage, detailRefreshKey]);
  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const fields = { title: title.trim(), targetUrl: url.trim() };
    if (
      !createRequest.current ||
      createRequest.current.title !== fields.title ||
      createRequest.current.targetUrl !== fields.targetUrl
    ) {
      createRequest.current = { id: crypto.randomUUID(), ...fields };
    }
    setBusy(true);
    setError("");
    try {
      const link = await qrApi<QrLink>("/links", {
        method: "POST",
        body: JSON.stringify(createRequest.current),
      });
      if (!mounted.current) return;
      createRequest.current = null;
      setTitle("");
      setUrl("");
      setSelected(link);
      setHistoryPage(0);
      setPage(0);
      notify("QRコードを作成しました。");
      void refresh();
    } catch (e) {
      setError(`${errorText(e)} 同じ内容で再試行しても重複登録しません。`);
    } finally {
      setBusy(false);
    }
  }
  async function copy(
    link: QrLink,
    source: "qr" | "button" | "link" = "button",
  ) {
    try {
      await navigator.clipboard.writeText(trackingUrl(link.code, source));
      notify("計測用URLをコピーしました。");
    } catch {
      notify(
        "コピーできませんでした。表示されたURLを選択してコピーしてください。",
      );
    }
  }
  async function toggle(link: QrLink) {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await qrApi<QrLink>(`/links/${link.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !link.active }),
      });
      if (!mounted.current) return;
      setSelected((prev) => (prev?.id === link.id ? updated : prev));
      await refresh();
      notify(
        updated.active
          ? "QRコードを再開しました。"
          : "QRコードを停止しました。読み込んでも転送されません。",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function chooseView(next: "active" | "trash") {
    if (busy || view === next) return;
    setView(next);
    setPage(0);
    setLinks([]);
    setTotal(0);
    setLoading(true);
    setSelected(null);
    setError("");
  }
  function askDelete(link: QrLink, action: "trash" | "purge") {
    setConfirmation({ link, action });
    setPermanentConfirmed(false);
    setActionError("");
  }
  async function lifecycle(
    link: QrLink,
    action: "trash" | "restore" | "purge",
  ) {
    if (busy || (action === "purge" && !permanentConfirmed)) return;
    setBusy(true);
    setActionError("");
    setError("");
    try {
      const { path, ...options } = lifecycleRequest(
        link.id,
        action,
        permanentConfirmed,
      );
      await qrApi(path, options);
      if (!mounted.current) return;
      ++listRequest.current;
      setConfirmation(null);
      setSelected((previous) => (previous?.id === link.id ? null : previous));
      setLinks((previous) => previous.filter((row) => row.id !== link.id));
      setTotal((previous) => Math.max(0, previous - 1));
      notify(
        action === "trash"
          ? "ゴミ箱へ移動しました。転送は停止し、アクセス履歴は保持しています。"
          : action === "restore"
            ? "QRコードを復元しました。転送は停止中です。登録済み一覧から必要に応じて再開してください。"
            : "QRコードとアクセス履歴を完全削除しました。復元はできません。",
      );
      await refresh();
    } catch (e) {
      const message = `${errorText(e)} 一覧を更新して状態を確認してください。`;
      if (action === "restore") setError(message);
      else setActionError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="qr-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MARUGO QR TRACK</div>
          <h1>QR・短縮URLのアクセス分析</h1>
          <p>
            QRとリンクボタンを作成し、アクセスの推移・流入元を確認できます。
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => {
            void refresh();
            setDetailRefreshKey((n) => n + 1);
          }}
          disabled={loading || busy || !isCloud}
        >
          <RefreshCw size={16} />
          更新
        </button>
      </div>
      {!isCloud ? (
        <div className="empty-state">
          QR機能は共有ワークスペースで利用できます。公開サイトへログインしてください。
        </div>
      ) : (
        <>
          {workspaceView === undefined && (
            <div
              className="qr-view-tabs qr-segmented"
              role="group"
              aria-label="QRコードの一覧"
            >
              <button
                type="button"
                aria-pressed={view === "active"}
                disabled={busy}
                onClick={() => chooseView("active")}
              >
                <QrCode size={16} />
                登録済みQRコード
              </button>
              <button
                type="button"
                aria-pressed={view === "trash"}
                disabled={busy}
                onClick={() => chooseView("trash")}
              >
                <Trash2 size={16} />
                ゴミ箱
              </button>
            </div>
          )}
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          {view === "active" && (
            <>
              <div
                className="qr-create-method-tabs qr-segmented"
                role="tablist"
                aria-label="QRコードの作成方法"
                onKeyDown={(event) => {
                  if (busy) return;
                  const tabs = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="tab"]',
                    ),
                  );
                  const current = tabs.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const next =
                    event.key === "ArrowRight"
                      ? (current + 1) % tabs.length
                      : event.key === "ArrowLeft"
                        ? (current - 1 + tabs.length) % tabs.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? tabs.length - 1
                            : current;
                  if (next === current || current < 0) return;
                  event.preventDefault();
                  tabs[next].focus();
                  setCreateMode(next === 0 ? "file" : "link");
                }}
              >
                <button
                  id="qr-create-file-tab"
                  type="button"
                  role="tab"
                  aria-selected={createMode === "file"}
                  aria-controls="qr-create-file-panel"
                  tabIndex={createMode === "file" ? 0 : -1}
                  disabled={busy}
                  onClick={() => setCreateMode("file")}
                >
                  ファイルから作成
                </button>
                <button
                  id="qr-create-link-tab"
                  type="button"
                  role="tab"
                  aria-selected={createMode === "link"}
                  aria-controls="qr-create-link-panel"
                  tabIndex={createMode === "link" ? 0 : -1}
                  disabled={busy}
                  onClick={() => setCreateMode("link")}
                >
                  URLから作成
                </button>
              </div>
              <div
                id="qr-create-file-panel"
                role="tabpanel"
                aria-labelledby="qr-create-file-tab"
                hidden={createMode !== "file"}
              >
                <QrFileUpload
                  busy={busy}
                  onBusy={setBusy}
                  onCreated={(link) => {
                    if (!mounted.current) return;
                    setSelected(link);
                    setHistoryPage(0);
                    setPage(0);
                    notify("ファイルを公開してQRコードを発行しました。");
                    void refresh();
                  }}
                />
              </div>
              <div
                id="qr-create-link-panel"
                role="tabpanel"
                aria-labelledby="qr-create-link-tab"
                hidden={createMode !== "link"}
              >
                <form className="qr-create-card" onSubmit={create}>
                  <label>
                    管理用の名前
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={120}
                      placeholder="例：店頭ポスター・秋のキャンペーン"
                      required
                      disabled={busy}
                    />
                  </label>
                  <label>
                    リンク先URL
                    <input
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      maxLength={2048}
                      placeholder="https://example.com/"
                      required
                      disabled={busy}
                    />
                  </label>
                  <button className="button primary" disabled={busy}>
                    {busy ? (
                      <LoaderCircle size={17} className="spin" />
                    ) : (
                      <QrCode size={17} />
                    )}
                    QRコードを作成
                  </button>
                  <p>
                    QRには短い計測用URLが入ります。開くとアクセスを記録し、リンク先へ自動転送します。
                  </p>
                </form>
                <p className="qr-measure-note">
                  QR用・ボタン用・通常リンク用のURLで経路を識別します。延べアクセスには再読み込み・直接クリック・ボットも含みます。ユニークは匿名IDによるブラウザー単位の目安で、人数や移動先の表示完了は計測しません。過去のユニーク数は復元できません。流入元が渡されない場合や以前のURLは「不明」です。端末・ブラウザーは推定です。
                </p>
              </div>
            </>
          )}
          {view === "trash" && (
            <p className="qr-measure-note">
              ゴミ箱内のQR・短縮URLは転送されません。アクセス数・履歴・公開ファイルは復元するまで保持されます。復元後も転送は停止中です。完全削除するとQRの設定・全アクセス履歴・公開ファイル本体が消え、元に戻せません。自動削除はしません。
            </p>
          )}
          {selected && (
            <section className="qr-detail-card" aria-label="QRコードの詳細">
              <div className="qr-preview">
                {qr ? (
                  <img src={qr} alt={`${selected.title}のQRコード`} />
                ) : qrError ? (
                  <p role="alert">{qrError}</p>
                ) : (
                  <LoaderCircle className="spin" />
                )}
                <a
                  className={`button secondary ${!qr ? "qr-disabled" : ""}`}
                  href={qr || undefined}
                  download={`marugo-qr-${selected.code}.png`}
                  aria-disabled={!qr}
                  onClick={(e) => {
                    if (!qr) {
                      e.preventDefault();
                    }
                  }}
                >
                  <ArrowDownToLine size={16} />
                  PNGを保存
                </a>
              </div>
              <div className="qr-detail-body">
                <div className="qr-detail-heading">
                  <h2>{selected.title}</h2>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="QR詳細を閉じる"
                    onClick={() => setSelected(null)}
                  >
                    <X size={18} />
                  </button>
                </div>
                <span
                  className={`qr-status ${selected.active ? "" : "paused"}`}
                >
                  {selected.active ? "転送中" : "停止中"}
                </span>
                <p className="qr-count">
                  {selected.scan_count.toLocaleString()}
                  <small>回のアクセス</small>
                </p>
                <label>
                  ボタン用の短縮URL
                  <div className="qr-copy-row">
                    <input
                      readOnly
                      value={trackingUrl(selected.code, "button")}
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => void copy(selected)}
                    >
                      <Copy size={15} />
                      コピー
                    </button>
                  </div>
                </label>
                <label>
                  QR用の短縮URL
                  <div className="qr-copy-row">
                    <input
                      readOnly
                      value={trackingUrl(selected.code, "qr")}
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => void copy(selected, "qr")}
                    >
                      QR用をコピー
                    </button>
                  </div>
                </label>
                <div className="qr-link-tools">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void copy(selected, "link")}
                  >
                    通常リンク用をコピー
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          buttonHtml(
                            trackingUrl(selected.code, "button"),
                            selected.title,
                          ),
                        );
                        notify(
                          "リンクボタンのHTMLをコピーしました。サイトのHTMLに貼り付けて使えます。",
                        );
                      } catch {
                        notify(
                          "HTMLをコピーできませんでした。ボタン用のURLをサイトのリンク先に指定してください。",
                        );
                      }
                    }}
                  >
                    リンクボタンのHTMLをコピー
                  </button>
                </div>
                <p className="qr-analysis-meta">
                  QR画像はQR用URLを使用します。ボタンにはボタン用URLを指定してください。URLの識別情報で分類するため、QR用URLをボタンに使うとQR経由として計上されます。
                </p>
                <p className="qr-target">転送先：{selected.target_url}</p>
                <button
                  className="button secondary"
                  onClick={() => void toggle(selected)}
                  disabled={busy}
                >
                  {selected.active ? <Pause size={15} /> : <Play size={15} />}
                  {selected.active ? "転送を停止" : "転送を再開"}
                </button>
                <button
                  type="button"
                  className="button danger qr-trash-button"
                  disabled={busy}
                  onClick={() => askDelete(selected, "trash")}
                >
                  <Trash2 size={15} />
                  ゴミ箱へ移動
                </button>
                <h3>
                  アクセス履歴 <small>日本時間</small>
                </h3>
                {historyError ? (
                  <p className="error-message" role="alert">
                    {historyError}
                  </p>
                ) : !history ? (
                  <p>履歴を読み込み中…</p>
                ) : (
                  <>
                    {!history.events.length ? (
                      <p>まだアクセス履歴がありません。</p>
                    ) : (
                      <div
                        className="qr-table-scroll"
                        role="region"
                        aria-label="アクセス履歴の表"
                        tabIndex={0}
                      >
                        <table className="qr-data-table">
                          <caption>
                            個別のアクセス履歴（最新順・日本時間）
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">日時</th>
                              <th scope="col">経路</th>
                              <th scope="col">流入元サイト</th>
                              <th scope="col">端末</th>
                              <th scope="col">ブラウザー</th>
                            </tr>
                          </thead>
                          <tbody>
                            {history.events.map((event) => (
                              <tr key={event.id}>
                                <td>
                                  <time dateTime={event.accessed_at}>
                                    {dateTime(event.accessed_at)}
                                  </time>
                                </td>
                                <td>{sourceLabels[event.source] ?? "不明"}</td>
                                <td>
                                  {event.referrer_host || "不明／直接アクセス"}
                                </td>
                                <td>{deviceLabels[event.device] ?? "不明"}</td>
                                <td title={event.user_agent || ""}>
                                  {browserLabels[event.browser] ?? "不明"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {history.total > 30 && (
                      <div className="qr-pagination">
                        <button
                          className="button secondary"
                          disabled={historyPage === 0}
                          onClick={() => setHistoryPage((p) => p - 1)}
                        >
                          前へ
                        </button>
                        <span>
                          {historyPage + 1} / {Math.ceil(history.total / 30)}
                        </span>
                        <button
                          className="button secondary"
                          disabled={(historyPage + 1) * 30 >= history.total}
                          onClick={() => setHistoryPage((p) => p + 1)}
                        >
                          次へ
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>
          )}
          {selected && (
            <QrAnalytics linkId={selected.id} refreshKey={detailRefreshKey} />
          )}
          <div className="qr-list-heading">
            <h2>{view === "trash" ? "ゴミ箱" : "登録済みQRコード"}</h2>
            <span>{total}件</span>
          </div>
          {loading ? (
            <p>
              <LoaderCircle size={18} className="spin" />
              読み込み中…
            </p>
          ) : !links.length ? (
            <div className="empty-state">
              {view === "trash"
                ? "ゴミ箱は空です。"
                : "名前とURLを入力して、最初のQRコードを作成してください。"}
            </div>
          ) : (
            <div className="qr-link-list">
              {links.map((link) =>
                view === "trash" ? (
                  <div key={link.id} className="qr-link-row qr-trash-row">
                    <span className="qr-link-icon">
                      <Trash2 size={24} />
                    </span>
                    <span className="qr-link-title">
                      <b>{link.title}</b>
                      <small>{link.target_url}</small>
                      <small>
                        ゴミ箱へ移動{" "}
                        {link.deleted_at ? dateTime(link.deleted_at) : "—"}
                      </small>
                      <small>
                        {link.scan_count.toLocaleString()}
                        回のアクセス・履歴を保持
                      </small>
                    </span>
                    <div className="qr-trash-actions">
                      <button
                        type="button"
                        className="button secondary"
                        aria-label={`${link.title}を復元`}
                        disabled={busy}
                        onClick={() => void lifecycle(link, "restore")}
                      >
                        <RotateCcw size={16} />
                        復元
                      </button>
                      <button
                        type="button"
                        className="button danger"
                        aria-label={`${link.title}を完全削除`}
                        disabled={busy}
                        onClick={() => askDelete(link, "purge")}
                      >
                        <Trash2 size={16} />
                        完全削除
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    key={link.id}
                    className={`qr-link-row ${
                      selected?.id === link.id ? "selected" : ""
                    }`}
                    disabled={busy}
                    onClick={() => {
                      setSelected(link);
                      setHistoryPage(0);
                    }}
                  >
                    <span className="qr-link-icon">
                      <QrCode size={24} />
                    </span>
                    <span className="qr-link-title">
                      <b>{link.title}</b>
                      <small>{link.target_url}</small>
                      <small>作成 {dateTime(link.created_at)}</small>
                    </span>
                    <span
                      className={`qr-status ${link.active ? "" : "paused"}`}
                    >
                      {link.active ? "転送中" : "停止中"}
                    </span>
                    <span className="qr-row-count">
                      {link.scan_count.toLocaleString()}
                      <small>アクセス</small>
                    </span>
                  </button>
                ),
              )}
            </div>
          )}
          {total > 50 && (
            <div className="qr-pagination">
              <button
                className="button secondary"
                disabled={!page}
                onClick={() => setPage((p) => p - 1)}
              >
                前へ
              </button>
              <span>
                {page + 1} / {Math.ceil(total / 50)}
              </span>
              <button
                className="button secondary"
                disabled={(page + 1) * 50 >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                次へ
              </button>
            </div>
          )}
        </>
      )}
      {confirmation && (
        <Modal
          title={
            confirmation.action === "purge"
              ? "QRコードを完全削除しますか？"
              : "QRコードをゴミ箱へ移動しますか？"
          }
          subtitle={confirmation.link.title}
          onClose={() => setConfirmation(null)}
          locked={busy}
        >
          <p className="qr-deletion-note">
            {confirmation.action === "purge"
              ? "このQRコードの設定・累計アクセス数・全アクセス履歴・公開ファイル本体を完全に削除します。復元できず、配布済みのQR・短縮URLも利用できなくなります。"
              : "このQRコードと短縮URLの転送を停止し、登録済み一覧からゴミ箱へ移動します。アクセス数・履歴は残り、ゴミ箱から復元できます。"}
          </p>
          {confirmation.action === "purge" && (
            <label className="qr-purge-confirm">
              <input
                type="checkbox"
                checked={permanentConfirmed}
                disabled={busy}
                onChange={(event) =>
                  setPermanentConfirmed(event.target.checked)
                }
              />
              QRコード・全アクセス履歴・公開ファイルが消え、復元できないことを確認しました
            </label>
          )}
          {actionError && (
            <p className="error-message" role="alert">
              {actionError}
            </p>
          )}
          <div className="modal-footer">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              キャンセル
            </button>
            <button
              type="button"
              className="button danger"
              disabled={
                busy || (confirmation.action === "purge" && !permanentConfirmed)
              }
              onClick={() =>
                void lifecycle(confirmation.link, confirmation.action)
              }
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <Trash2 size={16} />
              )}
              {busy
                ? "処理しています…"
                : confirmation.action === "purge"
                  ? "完全削除する"
                  : "ゴミ箱へ移動する"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
