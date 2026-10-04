import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  accountApi,
  accountRedirect,
  finishAccountCallback,
  completeAccountRecovery,
  qrAuth,
  qrGoogleAuthEnabled,
  signInQrWithGoogle,
  type QrStore,
} from "./qr-account-client";
import { passwordProblem } from "./qr-account-routing.mjs";

export function QrAccountAccess({
  onAuthenticated,
  onBusy,
  sharedGoogle = false,
}: {
  onAuthenticated: () => void;
  onBusy?: (busy: boolean) => void;
  sharedGoogle?: boolean;
}) {
  const [mode, setMode] = useState<
    "login" | "signup" | "forgot" | "resend" | "recovery"
  >("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [stores, setStores] = useState<QrStore[]>([]);
  const [storeId, setStoreId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const recoveryAllowed = useRef(false);
  const submitting = useRef(false);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await finishAccountCallback();
        if (!alive) return;
        if (result.recovery) {
          recoveryAllowed.current = true;
          setMode("recovery");
          setMessage("新しいパスワードを設定してください。");
        } else if (result.message) setMessage(result.message);
        const { data } = await qrAuth.auth.getSession();
        if (alive) {
          setSignedIn(!!data.session);
          setEmail(data.session?.user.email || "");
        }
      } catch (e) {
        if (alive)
          setError(
            e instanceof Error
              ? e.message
              : "ログイン情報を確認できませんでした。",
          );
      } finally {
        if (alive) setReady(true);
      }
    })();
    const {
      data: { subscription },
    } = qrAuth.auth.onAuthStateChange((_event, session) => {
      if (alive) {
        setSignedIn(!!session);
        if (session?.user.email) setEmail(session.user.email);
      }
    });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (mode !== "signup") return;
    let alive = true;
    void accountApi<{ stores: QrStore[] }>("/stores", {}, true)
      .then((data) => {
        if (alive) setStores(data.stores);
      })
      .catch(() => {
        if (alive)
          setError(
            "所属店舗を取得できませんでした。接続を確認し、画面を開き直してください。",
          );
      });
    return () => {
      alive = false;
    };
  }, [mode]);
  function changeMode(next: "login" | "signup" | "forgot" | "resend") {
    if (submitting.current) return;
    setMode(next);
    setError("");
    setMessage("");
    setPassword("");
    setConfirmation("");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    setMessage("");
    if (mode === "signup" || mode === "recovery") {
      const problem = passwordProblem(password, confirmation);
      if (problem) {
        setError(problem);
        return;
      }
    }
    if (mode === "signup" && !stores.some((store) => store.id === storeId)) {
      setError("所属店舗を選択してください。");
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      if (mode === "login") {
        const { error: failure } = await qrAuth.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (failure)
          throw new Error(
            "ログインできませんでした。メールアドレス・パスワードとメール確認の完了を確認してください。",
          );
        setPassword("");
        onAuthenticated();
      } else if (mode === "signup") {
        const { error: failure } = await qrAuth.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            emailRedirectTo: accountRedirect("confirm"),
            data: { marugo_qr_store_id: storeId },
          },
        });
        if (failure)
          throw new Error(
            "登録・メール送信の結果を確認できませんでした。確認メールや管理者の登録一覧をご確認ください。登録済みの場合はログインまたは確認メールの再送をお試しください。",
          );
        setPassword("");
        setConfirmation("");
        setMode("login");
        setMessage(
          "確認メールをご確認ください。同じ端末・ブラウザーでリンクを開いた後、管理者による所属承認をお待ちください。すでに登録済みの場合はログインしてください。",
        );
      } else if (mode === "forgot") {
        const { error: failure } = await qrAuth.auth.resetPasswordForEmail(
          normalizedEmail,
          { redirectTo: accountRedirect("recovery") },
        );
        if (failure)
          throw new Error(
            "再設定メールを送信できませんでした。時間をおいてもう一度お試しください。",
          );
        setMessage(
          "登録されている場合は再設定メールが届きます。メールを送信した同じ端末・ブラウザーでリンクを開いてください。",
        );
      } else if (mode === "resend") {
        const { error: failure } = await qrAuth.auth.resend({
          type: "signup",
          email: normalizedEmail,
          options: { emailRedirectTo: accountRedirect("confirm") },
        });
        if (failure)
          throw new Error(
            "確認メールを送信できませんでした。時間をおいてもう一度お試しください。",
          );
        setMessage(
          "確認が必要なアカウントの場合はメールが届きます。同じ端末・ブラウザーで開いてください。",
        );
      } else {
        if (!recoveryAllowed.current)
          throw new Error("再設定メールのリンクから開き直してください。");
        const { error: failure } = await qrAuth.auth.updateUser({ password });
        if (failure)
          throw new Error(
            "パスワードの変更結果を確認できませんでした。新しいパスワードでログインを確認し、必要であれば再設定メールを送信し直してください。",
          );
        recoveryAllowed.current = false;
        completeAccountRecovery();
        setPassword("");
        setConfirmation("");
        setMode("login");
        setMessage("パスワードを変更しました。MARUGO QRを開いてください。");
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "通信結果を確認できませんでした。",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  async function googleLogin() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await signInQrWithGoogle();
    } catch {
      setError(
        "Googleログインを開始できませんでした。時間をおいてもう一度お試しください。",
      );
      submitting.current = false;
      setBusy(false);
    }
  }
  if (!ready) return <p role="status">QRのログイン情報を確認しています…</p>;
  return (
    <div className="qr-account-access">
      <h3>
        {mode === "signup"
          ? "新規登録"
          : mode === "resend"
            ? "確認メールを再送"
            : mode === "forgot"
              ? "パスワードを再設定"
              : mode === "recovery"
                ? "新しいパスワード"
                : "店舗別のQR管理へ"}
      </h3>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="qr-account-message" role="status">
          {message}
        </div>
      )}
      {signedIn && mode !== "recovery" ? (
        <>
          <p>{email}</p>
          <button
            type="button"
            className="button primary"
            onClick={onAuthenticated}
          >
            MARUGO QRを開く
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={async () => {
              const { error: failure } = await qrAuth.auth.signOut({
                scope: "local",
              });
              if (failure)
                setError(
                  "ログアウトできませんでした。もう一度お試しください。",
                );
            }}
          >
            別のアカウントでログイン
          </button>
        </>
      ) : (
        <form onSubmit={submit}>
          {mode === "login" && qrGoogleAuthEnabled && !sharedGoogle && (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void googleLogin()}
              >
                Googleで続ける
              </button>
              <p>またはメールアドレスでログイン</p>
            </>
          )}
          {mode !== "recovery" && (
            <label className="field">
              メールアドレス
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
              />
            </label>
          )}
          {mode === "signup" && (
            <label className="field">
              所属店舗
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                required
                disabled={busy || !stores.length}
              >
                <option value="">店舗を選択してください</option>
                {stores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode !== "forgot" && mode !== "resend" && (
            <label className="field">
              {mode === "recovery" ? "新しいパスワード" : "パスワード"}
              <input
                type="password"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === "login" ? undefined : 12}
                maxLength={128}
                disabled={busy}
              />
            </label>
          )}
          {(mode === "signup" || mode === "recovery") && (
            <label className="field">
              パスワード（確認）
              <input
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                required
                minLength={12}
                maxLength={128}
                disabled={busy}
              />
              <small>12文字以上。使い回しを避けてください。</small>
            </label>
          )}
          <button
            className="button primary"
            disabled={busy || (mode === "signup" && !stores.length)}
          >
            {busy
              ? "処理しています…"
              : mode === "signup"
                ? "確認メールを送って登録"
                : mode === "forgot"
                  ? "再設定メールを送る"
                  : mode === "resend"
                    ? "確認メールを再送"
                    : mode === "recovery"
                      ? "パスワードを変更"
                      : "MARUGO QRにログイン"}
          </button>
        </form>
      )}
      {mode !== "recovery" && !signedIn && (
        <div className="qr-auth-links">
          {mode !== "signup" && (
            <button
              type="button"
              onClick={() => changeMode("signup")}
              disabled={busy}
            >
              新規登録
            </button>
          )}
          {mode !== "forgot" && (
            <button
              type="button"
              onClick={() => changeMode("forgot")}
              disabled={busy}
            >
              パスワードを忘れた方
            </button>
          )}
          {mode !== "login" && (
            <button
              type="button"
              onClick={() => changeMode("login")}
              disabled={busy}
            >
              ログインに戻る
            </button>
          )}
          {mode !== "resend" && (
            <button
              type="button"
              onClick={() => changeMode("resend")}
              disabled={busy}
            >
              確認メールを再送する
            </button>
          )}
        </div>
      )}
      <div className="login-account-note">
        <p>
          QRは個人のメールアドレスでログインします。店舗の登録・履歴・ファイルは所属店舗内で共有されます。新規登録はメール確認と管理者承認が必要です。既存のレシピアプリと同じメールアドレスを使う場合、アカウントとパスワードは共通です。kotonohaの共通IDとは別です。
        </p>
      </div>
    </div>
  );
}
