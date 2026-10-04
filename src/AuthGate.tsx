import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  AudioLines,
  ArrowRight,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  QrCode,
  Check,
} from "lucide-react";
import {
  isCloud,
  getSession,
  SESSION_EVENT,
  signIn,
  clearSession,
  type SharedSession,
} from "./cloud";
import { api } from "./api";
import { ExternalApplications } from "./ExternalApplications";
import { QrAccountAccess } from "./QrAccountAccess";
import { PortalGoogleAccess } from "./PortalGoogleAccess";
import { portalGoogleAuthEnabled, qrAuth } from "./qr-account-client";
import { isAccountNavigation } from "./qr-account-routing.mjs";
import "./qr-accounts.css";

export type Application = "kotonoha" | "qr";
export function AuthGate({
  children,
}: {
  children: (
    application: Application,
    chooseApplication: () => void,
  ) => ReactNode;
}) {
  const [selectedApplication, setSelectedApplication] = useState<Application>(
    isAccountNavigation(location.search, location.hash) &&
      (!portalGoogleAuthEnabled ||
        new URLSearchParams(location.search).get("account") !== "google")
      ? "qr"
      : "kotonoha",
  );
  const [application, setApplication] = useState<Application | null>(null);
  const [session, setSession] = useState<SharedSession | null>(null);
  const [loading, setLoading] = useState(isCloud);
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<string | null>(null);
  useEffect(() => {
    if (!portalGoogleAuthEnabled || !isCloud) return;
    let alive = true;
    const sync = (id: string | null) => {
      if (!alive) return;
      const restored = getSession();
      if (restored?.googleUserId && restored.googleUserId !== id)
        clearSession();
      setIdentity(id);
    };
    const {
      data: { subscription },
    } = qrAuth.auth.onAuthStateChange((_event, current) =>
      sync(current?.user.id ?? null),
    );
    void qrAuth.auth
      .getSession()
      .then(({ data }) => sync(data.session?.user.id ?? null));
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!isCloud) return;
    let alive = true;
    const sync = () => {
      const restored = getSession();
      const usable =
        restored?.googleUserId && restored.googleUserId !== identity
          ? null
          : restored;
      setSession(usable);
      if (!usable)
        setApplication((current) => (current === "kotonoha" ? null : current));
      setLoading(false);
    };
    async function restore() {
      if (!getSession()) {
        if (alive) sync();
        return;
      }
      try {
        await api("/auth/session");
        if (alive) sync();
      } catch {
        if (alive) {
          setLoading(false);
          setError(
            "ログイン情報を確認できませんでした。再度ログインしてください。",
          );
        }
      }
    }
    void restore();
    window.addEventListener(SESSION_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      alive = false;
      window.removeEventListener(SESSION_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [identity]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      clearSession,
      Math.max(0, Date.parse(session.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    document.title =
      application === "qr"
        ? "MARUGO QR — QRコード作成・アクセス分析"
        : application === "kotonoha"
          ? "kotonoha — 会議録ワークスペース"
          : "MARUGO — アプリ選択・ログイン";
  }, [application]);
  async function login(e: FormEvent) {
    e.preventDefault();
    if (!isCloud || session) {
      setApplication(selectedApplication);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await signIn(loginId.trim(), password);
      setPassword("");
      setApplication(selectedApplication);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "ID・パスワードと接続状態を確認してください。",
      );
    } finally {
      setBusy(false);
    }
  }
  if (application && (application === "qr" || !isCloud || session))
    return (
      <>
        {children(application, () => {
          setApplication(null);
          setError("");
        })}
      </>
    );
  if (loading)
    return (
      <div className="auth-loading">
        <LoaderCircle className="spin" size={26} />
        <span>ワークスペースを準備しています</span>
      </div>
    );
  return (
    <div className="login-page">
      <section className="login-story">
        <div className="brand">
          <span className="brand-symbol">
            <QrCode size={24} />
          </span>
          <span>
            MARUGO<small>仕事を進める、アプリの入口。</small>
          </span>
        </div>
        <div className="login-story-body">
          <span className="eyebrow">MARUGO APPS</span>
          <h1>
            仕事の入口を、
            <br />
            ひとつに。
          </h1>
          <p>記録・共有・管理・分析。使いたいアプリを選んでください。</p>
          <ExternalApplications />
        </div>
        <span className="login-models">
          移動先のログイン・アクセス権は各アプリの設定に従います。
        </span>
      </section>
      <section className="login-form-panel">
        <div className="login-form-content">
          <span className="login-lock">
            <LockKeyhole size={25} />
          </span>
          <h2>このページで開く</h2>
          <p>
            {session
              ? "会議録にログイン済みです。QRの利用権限は別途確認します。"
              : "アプリを選んでログインしてください。QRは個人のメールアドレスで利用します。"}
          </p>
          <fieldset className="application-options" disabled={busy}>
            <legend>利用するアプリ</legend>
            {(
              [
                {
                  id: "kotonoha",
                  name: "kotonoha",
                  note: "会議録・文字起こし・議事録",
                  Icon: AudioLines,
                },
                {
                  id: "qr",
                  name: "MARUGO QR",
                  note: "QRコード作成・アクセス分析",
                  Icon: QrCode,
                },
              ] as const
            ).map(({ id, name, note, Icon }) => (
              <label
                className={`application-option ${selectedApplication === id ? "selected" : ""}`}
                key={id}
              >
                <input
                  type="radio"
                  name="application"
                  value={id}
                  checked={selectedApplication === id}
                  onChange={() => {
                    setSelectedApplication(id);
                    setError("");
                  }}
                />
                <Icon size={25} />
                <span>
                  <strong>{name}</strong>
                  <small>{note}</small>
                </span>
                {selectedApplication === id && (
                  <Check size={20} aria-hidden="true" />
                )}
              </label>
            ))}
          </fieldset>
          {portalGoogleAuthEnabled && isCloud && (
            <PortalGoogleAccess
              application={selectedApplication}
              onOpen={() => setApplication("kotonoha")}
              onBusy={setBusy}
              onIdentity={setIdentity}
            />
          )}
          {selectedApplication === "qr" ? (
            <QrAccountAccess
              onAuthenticated={() => setApplication("qr")}
              onBusy={setBusy}
              sharedGoogle={portalGoogleAuthEnabled}
            />
          ) : (
            <form onSubmit={login}>
              {isCloud && !session && (
                <>
                  <label className="field">
                    ログインID
                    <input
                      type="text"
                      autoComplete="username"
                      value={loginId}
                      onChange={(e) => setLoginId(e.target.value)}
                      autoCapitalize="none"
                      spellCheck={false}
                      required
                      placeholder="ログインIDを入力"
                    />
                  </label>
                  <label className="field">
                    パスワード
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </label>
                </>
              )}
              {error && (
                <div className="error-message" role="alert">
                  {error}
                </div>
              )}
              <button className="button primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <ArrowRight size={17} />
                )}
                {busy
                  ? "ログインしています…"
                  : `kotonoha${session || !isCloud ? "を開く" : "にログイン"}`}
              </button>
              <div className="login-account-note">
                <ShieldCheck size={17} />
                <p>
                  kotonohaはこれまでの共通IDも利用できます。Googleでの利用には本人連携と管理者承認が必要です。QRは個人アカウント・店舗別の管理です。共用端末では利用後にログアウトしてください。
                </p>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
