import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  LogOut,
  Menu,
  QrCode,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { QrPage } from "./QrPage";
import { QrAccountManagement } from "./QrAccountManagement";
import { QrScopeContext } from "./qr-api";
import {
  accountApi,
  qrAuth,
  type QrAccountContext,
  type QrStore,
} from "./qr-account-client";
import { getSession, SESSION_EVENT, signOut as signOutShared } from "./cloud";

export function QrWorkspace({ onChooseApp }: { onChooseApp: () => void }) {
  const [context, setContext] = useState<QrAccountContext | null>(null);
  const [sharedAccess, setSharedAccess] = useState(false);
  const [storeId, setStoreId] = useState("");
  const [tab, setTab] = useState<"qr" | "trash" | "accounts">("qr");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setMobile(media.matches);
      setSidebarOpen(false);
    };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!sidebarOpen) return;
    sidebar.current
      ?.querySelector<HTMLButtonElement>(".qr-menu-close")
      ?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        menuButton.current?.focus();
      }
      if (event.key === "Tab") {
        const items = Array.from(
          sidebar.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), select:not(:disabled)",
          ) || [],
        ).filter((item) => item.getClientRects().length);
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [sidebarOpen]);
  const [stores, setStores] = useState<QrStore[]>([]);
  const [requestedStore, setRequestedStore] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qrBusy, setQrBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(0);
  const identity = useRef<string | null>(null);
  const chooseRef = useRef(onChooseApp);
  chooseRef.current = onChooseApp;
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const {
        data: { session: qrSession },
      } = await qrAuth.auth.getSession();
      const sharedSession = getSession();
      if (!qrSession && !sharedSession) {
        chooseRef.current();
        return;
      }
      setSharedAccess(!qrSession && !!sharedSession);
      identity.current = qrSession?.user.id || sharedSession?.token || null;
      let next = await accountApi<QrAccountContext>("/context");
      const requested = qrSession?.user.user_metadata?.marugo_qr_store_id;
      if (
        !next.member &&
        typeof requested === "string" &&
        /^[0-9a-f-]{36}$/i.test(requested)
      )
        next = await accountApi<QrAccountContext>("/register", {
          method: "POST",
          body: JSON.stringify({ storeId: requested }),
        });
      if (request !== revision.current) return;
      setContext(next);
      setError("");
      setStoreId((previous) =>
        next.stores.some((store) => store.id === previous)
          ? previous
          : next.stores.find((store) => store.legacy)?.id ||
            next.stores[0]?.id ||
            "",
      );
      if (!next.member) {
        const list = await accountApi<{ stores: QrStore[] }>(
          "/stores",
          {},
          true,
        );
        if (request === revision.current) setStores(list.stores);
      }
    } catch (e) {
      if (request === revision.current) {
        setContext(null);
        setError(
          e instanceof Error ? e.message : "所属を確認できませんでした。",
        );
      }
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const {
      data: { subscription },
    } = qrAuth.auth.onAuthStateChange((event, session) => {
      if (
        event === "SIGNED_OUT" ||
        (event === "SIGNED_IN" && session?.user.id !== identity.current)
      ) {
        identity.current = session?.user.id || null;
        ++revision.current;
        setContext(null);
        setLoading(true);
        // Do not await Auth inside the SDK's locked auth-event callback.
        setTimeout(() => {
          void refresh();
        }, 0);
      }
    });
    const onSharedSession = () => {
      ++revision.current;
      setLoading(true);
      setTimeout(() => void refresh(), 0);
    };
    window.addEventListener(SESSION_EVENT, onSharedSession);
    const interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    return () => {
      ++revision.current;
      subscription.unsubscribe();
      window.removeEventListener(SESSION_EVENT, onSharedSession);
      clearInterval(interval);
    };
  }, [refresh]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  function notify(message: string) {
    setToast(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 5000);
  }
  const scope = useMemo(
    () =>
      context?.member && storeId
        ? { userId: context.member.user_id, storeId }
        : null,
    [context?.member?.user_id, storeId],
  );
  const active = context?.member?.status === "active";
  const admin = active && context?.member?.role === "admin";
  const canManageAccounts = admin && !sharedAccess;
  const selected = context?.stores.find((store) => store.id === storeId);
  const pageTitle =
    admin && tab === "accounts"
      ? "アカウント管理"
      : tab === "trash"
        ? "ゴミ箱"
        : "QR・アクセス分析";
  function navigate(next: typeof tab) {
    if (qrBusy) return;
    setTab(next);
    setSidebarOpen(false);
    if (mobile) menuButton.current?.focus();
  }
  return (
    <div className="app-shell qr-workspace">
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="メニューを閉じる"
          onClick={() => {
            setSidebarOpen(false);
            menuButton.current?.focus();
          }}
        />
      )}
      <aside
        ref={sidebar}
        id="qr-workspace-menu"
        className={`sidebar qr-sidebar ${sidebarOpen ? "open" : ""}`}
        aria-label="MARUGO QRメニュー"
        inert={mobile && !sidebarOpen}
      >
        <button
          className="icon-button mobile-menu qr-menu-close"
          aria-label="メニューを閉じる"
          onClick={() => {
            setSidebarOpen(false);
            menuButton.current?.focus();
          }}
        >
          <X size={20} />
        </button>
        <div className="brand">
          <span className="brand-symbol">
            <QrCode size={24} />
          </span>
          <span>
            MARUGO QR<small>店舗別 QRコード作成・アクセス分析</small>
          </span>
        </div>
        <div className="qr-sidebar-store">
          <span className="nav-label">
            {admin ? "全店舗管理者" : "所属店舗"}
          </span>
          {admin && context ? (
            <label className="field">
              表示する店舗
              <select
                value={storeId}
                disabled={qrBusy}
                onChange={(e) => {
                  setStoreId(e.target.value);
                  setToast("");
                  setSidebarOpen(false);
                }}
              >
                <option value="" disabled>
                  店舗を選択
                </option>
                {context.stores.map((store) => (
                  <option value={store.id} key={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>
              {active ? selected?.name || "店舗未選択" : "承認後に利用できます"}
            </p>
          )}
        </div>
        <span className="nav-label">メニュー</span>
        <nav aria-label="QR管理">
          <button
            className={tab === "qr" ? "active" : ""}
            aria-current={tab === "qr" ? "page" : undefined}
            disabled={!active || qrBusy}
            onClick={() => navigate("qr")}
          >
            <QrCode size={20} />
            QR・アクセス分析
          </button>
          <button
            className={tab === "trash" ? "active" : ""}
            aria-current={tab === "trash" ? "page" : undefined}
            disabled={!active || qrBusy}
            onClick={() => navigate("trash")}
          >
            <Trash2 size={20} />
            ゴミ箱
          </button>
          {canManageAccounts && (
            <button
              className={tab === "accounts" ? "active" : ""}
              aria-current={tab === "accounts" ? "page" : undefined}
              disabled={qrBusy}
              onClick={() => navigate("accounts")}
            >
              <Users size={20} />
              アカウント管理
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="settings-link"
            onClick={onChooseApp}
            disabled={qrBusy}
          >
            <ArrowLeft size={17} />
            アプリ選択に戻る
          </button>
          <button
            className="settings-link"
            disabled={qrBusy}
            onClick={async () => {
              try {
                const shared = getSession();
                if (shared) await signOutShared();
                else {
                  const { error: failure } = await qrAuth.auth.signOut({
                    scope: "local",
                  });
                  if (failure) throw failure;
                }
                setContext(null);
                onChooseApp();
              } catch {
                notify("ログアウトできませんでした。再度お試しください。");
              }
            }}
          >
            <LogOut size={17} />
            ログアウト
          </button>
        </div>
      </aside>
      <div className="main-shell" inert={mobile && sidebarOpen}>
        <header className="topbar qr-workspace-topbar">
          <div>
            <button
              ref={menuButton}
              className="icon-button mobile-menu"
              aria-label="メニューを開く"
              aria-expanded={sidebarOpen}
              aria-controls="qr-workspace-menu"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={21} />
            </button>
            <span>MARUGO QR</span>
            <ChevronRight size={16} />
            <strong>{pageTitle}</strong>
          </div>
          <span className="qr-workspace-email">{context?.email}</span>
        </header>
        <main className="qr-workspace-main">
          {loading ? (
            <p role="status">所属店舗を確認しています…</p>
          ) : (
            <>
              {error && (
                <div className="error-message" role="alert">
                  {error}
                  <button
                    className="button secondary"
                    onClick={() => void refresh()}
                  >
                    もう一度確認
                  </button>
                </div>
              )}
              {context && (
                <section className="qr-store-heading">
                  <div>
                    <span className="eyebrow">
                      {admin
                        ? "ALL STORES / 全店舗管理者"
                        : "MY STORE / 所属店舗"}
                    </span>
                    <h1>
                      {active
                        ? selected?.name || "店舗を選択してください"
                        : context.member?.status === "suspended"
                          ? "利用停止中"
                          : "所属店舗の承認待ち"}
                    </h1>
                    <p>{context.email}</p>
                  </div>
                </section>
              )}
              {context && !context.member && (
                <form
                  className="qr-affiliation-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (busy) return;
                    setBusy(true);
                    setError("");
                    try {
                      await accountApi("/register", {
                        method: "POST",
                        body: JSON.stringify({ storeId: requestedStore }),
                      });
                      await refresh();
                    } catch (failure) {
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : "所属を登録できませんでした。",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <p>
                    初めてQRを利用する方は所属店舗を申請してください。管理者の承認後に利用できます。
                  </p>
                  <label className="field">
                    所属店舗
                    <select
                      required
                      value={requestedStore}
                      onChange={(e) => setRequestedStore(e.target.value)}
                      disabled={busy}
                    >
                      <option value="">店舗を選択してください</option>
                      {stores.map((store) => (
                        <option key={store.id} value={store.id}>
                          {store.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button primary"
                    disabled={busy || !requestedStore}
                  >
                    {busy ? "申請中…" : "所属店舗を申請"}
                  </button>
                </form>
              )}
              {context?.member && !active && (
                <div className="qr-account-message">
                  {context.member.status === "pending"
                    ? `${context.member.store_name || "申請した店舗"}の所属確認を管理者へ依頼してください。承認されるまでQR・アクセス履歴・ファイルは表示されません。`
                    : "利用状態について管理者へお問い合わせください。"}
                  <button
                    className="button secondary"
                    onClick={() => void refresh()}
                  >
                    承認状態を更新
                  </button>
                </div>
              )}
              {canManageAccounts && tab === "accounts" ? (
                <QrAccountManagement
                  stores={context!.stores.filter((store) => !store.legacy)}
                  currentUserId={context!.member!.user_id}
                  notify={notify}
                />
              ) : (
                active &&
                selected &&
                scope && (
                  <QrScopeContext.Provider value={scope}>
                    <QrPage
                      key={`${scope.userId}:${scope.storeId}`}
                      notify={notify}
                      onBusyChange={setQrBusy}
                      workspaceView={tab === "trash" ? "trash" : "active"}
                    />
                  </QrScopeContext.Provider>
                )
              )}
            </>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
