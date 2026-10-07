import { useEffect, useRef, useState } from "react";
import {
  qrAuth,
  finishAccountCallback,
  signInQrWithGoogle,
} from "./qr-account-client";
import { clearSession, getSession } from "./cloud";
import {
  googleApi,
  openGoogleKotonoha,
  signOutGoogleAccount,
  type GoogleMember,
} from "./portal-google-client";

export function PortalGoogleAccess({
  application,
  onOpen,
  onBusy,
  onIdentity,
}: {
  application: "kotonoha" | "qr";
  onOpen: () => void;
  onBusy: (busy: boolean) => void;
  onIdentity: (id: string | null) => void;
}) {
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [member, setMember] = useState<GoogleMember | null>(null);
  const [members, setMembers] = useState<GoogleMember[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const currentId = useRef<string | null>(null);
  const flight = useRef(false);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    let alive = true;
    const sync = (next: { id: string; email?: string } | null) => {
      const changed = currentId.current !== (next?.id ?? null);
      currentId.current = next?.id ?? null;
      const session = getSession();
      if (session?.googleUserId && session.googleUserId !== next?.id)
        clearSession();
      if (alive) {
        setUser(next);
        if (changed) {
          setMember(null);
          setMembers([]);
        }
        onIdentity(next?.id ?? null);
      }
    };
    void finishAccountCallback()
      .then((result) => {
        // Password recovery is handled by the existing QR form, not this hub.
        if (alive && !result.recovery) setMessage(result.message);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(async () => {
        const { data } = await qrAuth.auth.getSession();
        if (alive) {
          sync(data.session?.user ?? null);
          setReady(true);
        }
      });
    const {
      data: { subscription },
    } = qrAuth.auth.onAuthStateChange((_event, session) =>
      sync(session?.user ?? null),
    );
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, [onIdentity]);
  async function refresh() {
    const id = currentId.current;
    const result = await googleApi<{ member: GoogleMember | null }>("/context");
    if (currentId.current !== id) return;
    setMember(result.member);
    if (result.member?.role === "admin" && result.member.status === "active") {
      const list = await googleApi<{ members: GoogleMember[] }>("/members");
      if (currentId.current === id) setMembers(list.members);
    } else setMembers([]);
  }
  useEffect(() => {
    if (!user || application !== "kotonoha") return;
    void refresh().catch((e) => setError(e.message));
  }, [user?.id, application]);
  async function run(action: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "処理結果を確認できませんでした。",
      );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="qr-account-access" aria-label="共通Googleログイン">
      <h3>Googleでログイン</h3>
      <p>本人確認は共通、会議録のチーム権限とQRの店舗権限は別々です。</p>
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
      {!ready ? (
        <p role="status">本人確認を準備しています…</p>
      ) : !user ? (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void run(signInQrWithGoogle)}
        >
          Googleで続ける
        </button>
      ) : (
        <>
          <p>{user.email}</p>
          {application === "qr" ? (
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={onOpen}
            >
              MARUGO QRを開く
            </button>
          ) : (
            <>
              <p>
                {member?.status === "active"
                  ? "会議録の利用が承認されています。"
                  : member?.status === "suspended"
                    ? "利用停止中です。管理者にご確認ください。"
                    : member?.status === "pending"
                      ? "承認待ちです。管理者の承認後に開けます。"
                      : "未連携です。下の共通IDでログインした後、連携を申請してください。"}
              </p>
              {member?.status === "active" && (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await openGoogleKotonoha();
                      onOpen();
                    })
                  }
                >
                  Googleアカウントでkotonohaを開く
                </button>
              )}
              {!member && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={
                    busy || !getSession() || !!getSession()?.googleUserId
                  }
                  onClick={() =>
                    void run(async () => {
                      await googleApi("/request", { method: "POST" });
                      await refresh();
                      setMessage(
                        "連携を申請しました。管理者の承認をお待ちください。",
                      );
                    })
                  }
                >
                  既存ログインと連携を申請
                </button>
              )}
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => void run(refresh)}
              >
                承認状態を更新
              </button>
              {member?.role === "admin" && member.status === "active" && (
                <details>
                  <summary>会議録の利用申請を管理</summary>
                  <p>
                    操作前に対象メールを確認してください。QRの店舗権限は変更されません。
                  </p>
                  {members.map((row) => (
                    <div key={row.user_id} className="qr-account-message">
                      <p>
                        {row.email} —{" "}
                        {row.status === "pending"
                          ? "承認待ち"
                          : row.status === "active"
                            ? "利用中"
                            : "停止中"}
                      </p>
                      {row.role !== "admin" &&
                        (row.status === "active"
                          ? ["suspend"]
                          : ["approve"]
                        ).map((action) => (
                          <button
                            key={action}
                            type="button"
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await googleApi(`/members/${row.user_id}`, {
                                  method: "POST",
                                  body: JSON.stringify({ action }),
                                });
                                await refresh();
                              })
                            }
                          >
                            {action === "approve"
                              ? "会議録の利用を承認"
                              : "会議録のGoogle利用を停止"}
                          </button>
                        ))}
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run(signOutGoogleAccount)}
          >
            共通アカウントをログアウト
          </button>
        </>
      )}
    </section>
  );
}
