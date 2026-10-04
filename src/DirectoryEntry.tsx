import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ShieldCheck,
  UsersRound,
  Search,
  RefreshCw,
  LogOut,
  LockKeyhole,
  Database,
} from "lucide-react";
import {
  qrAuth,
  finishAccountCallback,
  signInQrWithGoogle,
} from "./qr-account-client";
import { clearSession, getSession } from "./cloud";
import { directoryIntentKey } from "./directory-routing.mjs";
import {
  directorySources,
  directoryApps,
  directoryStatuses,
  checkDirectoryAdmin,
  getDirectoryPage,
  DirectoryError,
  type DirectoryPage,
} from "./directory-client";
import "./directory.css";

type SourceState = { page?: DirectoryPage; busy?: boolean; error?: string };
function date(value: string | null) {
  return value
    ? new Date(value).toLocaleString("ja-JP", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "記録なし";
}
export function UserDirectory() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState({ app: "", q: "", status: "" });
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const epoch = useRef(0);
  const identity = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    document.title = "登録ユーザー管理 | MARUGO";
    const sync = (u: { id: string; email?: string } | null) => {
      if (!mounted.current) return;
      if (identity.current !== (u?.id ?? null)) {
        epoch.current++;
        setSources({});
        setAuthorized(false);
        setError("");
      }
      identity.current = u?.id ?? null;
      setUser(u);
    };
    const {
      data: { subscription },
    } = qrAuth.auth.onAuthStateChange((_event, session) =>
      sync(session?.user ?? null),
    );
    void finishAccountCallback()
      .then(() => {
        sessionStorage.removeItem(directoryIntentKey);
        const u = new URL(location.href);
        u.searchParams.set("admin", "users");
        history.replaceState(null, "", u.pathname + u.search);
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      })
      .finally(async () => {
        const { data } = await qrAuth.auth.getSession();
        if (mounted.current) {
          sync(data.session?.user ?? null);
          setReady(true);
        }
      });
    return () => {
      mounted.current = false;
      epoch.current++;
      subscription.unsubscribe();
    };
  }, []);
  async function refresh() {
    const ticket = ++epoch.current;
    setError("");
    setBusy(true);
    setSources({});
    try {
      const result = await checkDirectoryAdmin();
      if (
        !mounted.current ||
        ticket !== epoch.current ||
        result.actor !== identity.current
      )
        return;
      setAuthorized(true);
      const selected = directorySources.filter(
        (s) =>
          !filters.app ||
          filters.app === "unassigned" ||
          s.apps.includes(filters.app),
      );
      await Promise.all(
        selected.map(async (source) => {
          setSources((old) => ({ ...old, [source.id]: { busy: true } }));
          try {
            const page = await getDirectoryPage(source, filters);
            if (mounted.current && ticket === epoch.current)
              setSources((old) => ({ ...old, [source.id]: { page } }));
          } catch (e) {
            if (!mounted.current || ticket !== epoch.current) return;
            if (e instanceof DirectoryError && [401, 403].includes(e.status)) {
              epoch.current++;
              setSources({});
              setAuthorized(false);
              setBusy(false);
              setError(e.message);
            } else
              setSources((old) => ({
                ...old,
                [source.id]: {
                  error:
                    e instanceof Error ? e.message : "取得できませんでした。",
                },
              }));
          }
        }),
      );
    } catch (e) {
      if (mounted.current && ticket === epoch.current) {
        setAuthorized(false);
        setError(e instanceof Error ? e.message : "認証を確認できません。");
      }
    } finally {
      if (mounted.current && ticket === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (ready && user) void refresh();
  }, [ready, user?.id, filters]);
  // Do not retain another account's directory or allow a background response to restore it.
  async function logout() {
    epoch.current++;
    setSources({});
    setAuthorized(false);
    setBusy(false);
    setError("");
    if (getSession()?.googleUserId) clearSession();
    const { error } = await qrAuth.auth.signOut({ scope: "local" });
    if (error) setError("ログアウトを確認できません。もう一度お試しください。");
  }
  async function login() {
    setBusy(true);
    setError("");
    try {
      sessionStorage.setItem(directoryIntentKey, "users");
      await signInQrWithGoogle();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ログインを開始できません。");
      setBusy(false);
    }
  }
  async function more(source: (typeof directorySources)[number]) {
    const previous = sources[source.id]?.page;
    if (!previous || previous.nextOffset === null || sources[source.id]?.busy)
      return;
    const ticket = epoch.current;
    setSources((old) => ({
      ...old,
      [source.id]: { page: previous, busy: true },
    }));
    try {
      const next = await getDirectoryPage(source, filters, previous.nextOffset);
      if (mounted.current && ticket === epoch.current)
        setSources((old) => ({
          ...old,
          [source.id]: {
            page: {
              ...next,
              rows: [
                ...previous.rows,
                ...next.rows.filter(
                  (r) => !previous.rows.some((p) => p.key === r.key),
                ),
              ],
            },
          },
        }));
    } catch (e) {
      if (!mounted.current || ticket !== epoch.current) return;
      if (e instanceof DirectoryError && [401, 403].includes(e.status)) {
        epoch.current++;
        setSources({});
        setAuthorized(false);
        setError(e.message);
      } else
        setSources((old) => ({
          ...old,
          [source.id]: {
            page: previous,
            error: "続きの取得に失敗しました。再試行してください。",
          },
        }));
    }
  }
  const loaded = Object.values(sources).filter((s) => s.page).length;
  const total = Object.values(sources).reduce(
    (n, s) => n + (s.page?.total ?? 0),
    0,
  );
  return (
    <main className="directory">
      <header className="dir-header">
        <a className="dir-brand" href={import.meta.env.BASE_URL}>
          <ShieldCheck aria-hidden="true" /> MARUGO <span>ADMIN</span>
        </a>
        <a href={import.meta.env.BASE_URL}>
          <ArrowLeft size={16} aria-hidden="true" /> アプリ一覧へ
        </a>
      </header>
      <section className="dir-hero">
        <div>
          <p className="dir-eyebrow">USER DIRECTORY</p>
          <h1>登録ユーザー管理</h1>
          <p>アプリを横断して、登録状況と利用状態を確認。</p>
        </div>
        <span className="dir-readonly">
          <LockKeyhole size={16} aria-hidden="true" /> 閲覧専用
        </span>
      </section>
      {error && (
        <div className="dir-error" role="alert">
          {error}
        </div>
      )}
      {!ready ? (
        <p role="status">本人確認を準備しています…</p>
      ) : !authorized ? (
        <section className="dir-login">
          <ShieldCheck size={36} aria-hidden="true" />
          <h2>管理者専用のページです</h2>
          <p>
            許可されたGoogleアカウントでログインしてください。
            <br />
            各アプリの利用権限が自動で増えることはありません。
          </p>
          {user && (
            <p className="dir-identity">現在のアカウント：{user.email}</p>
          )}
          <button onClick={() => void login()} disabled={busy}>
            Googleで続ける
          </button>
          {user && (
            <>
              <button
                className="dir-secondary"
                disabled={busy}
                onClick={() => void refresh()}
              >
                権限を再確認
              </button>
              <button className="dir-secondary" onClick={() => void logout()}>
                ログアウト
              </button>
            </>
          )}
          {busy && <p role="status">管理者権限を確認しています…</p>}
        </section>
      ) : (
        <>
          <div className="dir-session">
            <span>
              <ShieldCheck size={17} aria-hidden="true" /> {user?.email}
            </span>
            <button className="dir-secondary" onClick={() => void logout()}>
              <LogOut size={16} aria-hidden="true" /> ログアウト
            </button>
          </div>
          <section className="dir-stats" aria-label="取得状況">
            <div>
              <UsersRound aria-hidden="true" />
              <strong>{total}</strong>
              <span>検索に一致する登録レコード</span>
            </div>
            <div>
              <Database aria-hidden="true" />
              <strong>
                {loaded}
                <small> / 3</small>
              </strong>
              <span>今回取得した接続先</span>
            </div>
            <div>
              <ShieldCheck aria-hidden="true" />
              <strong>アプリ別</strong>
              <span>承認・停止状態を分けて表示</span>
            </div>
          </section>
          <form
            className="dir-filters"
            onSubmit={(e) => {
              e.preventDefault();
              setFilters((old) => ({ ...old, q: draft.trim() }));
            }}
          >
            <label className="dir-search">
              ユーザーを検索
              <div>
                <Search size={18} aria-hidden="true" />
                <input
                  value={draft}
                  maxLength={160}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="メールアドレス・名前・店舗・ID"
                />
              </div>
            </label>
            <label>
              アプリ
              <select
                value={filters.app}
                onChange={(e) =>
                  setFilters((old) => ({ ...old, app: e.target.value }))
                }
              >
                <option value="">すべての接続済みアプリ</option>
                {Object.entries(directoryApps).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              利用状態
              <select
                value={filters.status}
                onChange={(e) =>
                  setFilters((old) => ({ ...old, status: e.target.value }))
                }
              >
                <option value="">すべての状態</option>
                {Object.entries(directoryStatuses).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy}>
              検索
            </button>
            <button
              type="button"
              className="dir-secondary"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={17} aria-hidden="true" />
              再読込
            </button>
          </form>
          <p className="dir-explainer">
            同じメールでもアプリ・接続先ごとに表示します。件数は人数ではありません。「Authのみ」はそのアプリの利用許可を意味しません。最終ログインは接続先全体の記録です。
          </p>
          {directorySources
            .filter(
              (s) =>
                !filters.app ||
                filters.app === "unassigned" ||
                s.apps.includes(filters.app),
            )
            .map((source) => {
              const state = sources[source.id];
              return (
                <section className="dir-source" key={source.id}>
                  <div className="dir-source-heading">
                    <div>
                      <h2>{source.name}</h2>
                      <p>{source.note}</p>
                    </div>
                    <span className="dir-source-state">
                      {state?.busy
                        ? "取得中"
                        : state?.error
                          ? "取得エラー"
                          : state?.page
                            ? state.page.total + "件"
                            : "待機中"}
                    </span>
                  </div>
                  {state?.error && (
                    <p className="dir-error" role="alert">
                      {state.error}
                    </p>
                  )}
                  {state?.page && (
                    <>
                      <div className="dir-table-wrap">
                        <table>
                          <caption className="dir-sr-only">
                            {source.name}の登録者一覧
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">ユーザー</th>
                              <th scope="col">アプリ</th>
                              <th scope="col">利用状態 / 役割</th>
                              <th scope="col">店舗・チーム</th>
                              <th scope="col">最終ログイン</th>
                            </tr>
                          </thead>
                          <tbody>
                            {state.page.rows.map((row) => (
                              <tr key={row.key}>
                                <td>
                                  <strong>
                                    {row.name || row.email || "名称なし"}
                                  </strong>
                                  {row.name && row.email && (
                                    <span>{row.email}</span>
                                  )}
                                  <small>
                                    {row.provider || "認証方式未記録"}
                                    {row.email && !row.email_verified
                                      ? " / メール未確認"
                                      : ""}
                                  </small>
                                  <details>
                                    <summary>登録情報</summary>
                                    <small>
                                      ID: {row.user_id}
                                      <br />
                                      登録日時: {date(row.created_at)}
                                    </small>
                                  </details>
                                </td>
                                <td>
                                  {directoryApps[row.app_id] || row.app_id}
                                </td>
                                <td>
                                  <span
                                    className={
                                      "dir-badge dir-status-" + row.status
                                    }
                                  >
                                    {directoryStatuses[row.status] ||
                                      row.status}
                                  </span>
                                  <small>{row.role || "役割未登録"}</small>
                                </td>
                                <td>{row.affiliation || "所属の記録なし"}</td>
                                <td>{date(row.last_sign_in_at)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!state.page.rows.length && (
                        <p className="dir-empty">
                          条件に一致する登録情報はありません。
                        </p>
                      )}
                      <footer>
                        <small>
                          取得日時：{date(state.page.asOf)} ·{" "}
                          {state.page.rows.length} / {state.page.total}件を表示
                        </small>
                        {state.page.nextOffset !== null && (
                          <button
                            className="dir-secondary"
                            disabled={state.busy}
                            onClick={() => void more(source)}
                          >
                            続きの100件を表示
                          </button>
                        )}
                      </footer>
                    </>
                  )}
                </section>
              );
            })}
          <section className="dir-unavailable">
            <h2>
              meguri / 貸借管理 <span>未接続</span>
            </h2>
            <p>
              このデータベースへの接続権限がないため、登録者を取得していません。0人という意味ではありません。
            </p>
          </section>
        </>
      )}
      <footer className="dir-footnote">
        このページから承認・停止・削除は行いません。閲覧は監査記録に残ります。共有端末では必ずログアウトしてください。
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UserDirectory />
  </React.StrictMode>,
);
