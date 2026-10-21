import { useState, type FormEvent, type InvalidEvent } from "react";
import {
  Check,
  ChevronDown,
  KeyRound,
  LoaderCircle,
  Sparkles,
  Zap,
  Bell,
} from "lucide-react";
import { Modal } from "./Modal";
import { api } from "./api";
import type { Settings } from "./types";
import { isCloud } from "./cloud";

export function SettingsDialog({
  settings,
  onClose,
  onSave,
  onRequestNotification,
  notificationPermission,
}: {
  settings: Settings | null;
  onClose: () => void;
  onSave: (value: Settings) => void;
  onRequestNotification: () => void;
  notificationPermission: NotificationPermission;
}) {
  const [key, setKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [model, setModel] = useState(settings?.model || "gpt-6-astra");
  const [transcriptionModel, setTranscriptionModel] = useState(
    settings?.transcriptionModel || "gpt-transcribe",
  );
  const [openAiExpanded, setOpenAiExpanded] = useState(!settings?.configured);
  const [geminiExpanded, setGeminiExpanded] = useState(
    !settings?.geminiConfigured &&
      settings?.transcriptionModel === "gemini-3.5-transcribe",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function revealInvalidKey(
    e: InvalidEvent<HTMLInputElement>,
    provider: "openai" | "gemini",
  ) {
    // A collapsed invalid field must be revealed before it can receive focus.
    e.preventDefault();
    const input = e.currentTarget;
    if (provider === "openai") setOpenAiExpanded(true);
    else setGeminiExpanded(true);
    setError(
      `${provider === "openai" ? "OpenAI" : "Gemini"} APIキーは20文字以上で入力してください。`,
    );
    requestAnimationFrame(() => input.focus());
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await api<Settings>("/settings", {
        method: "PUT",
        body: JSON.stringify({
          model,
          transcriptionModel,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
          ...(geminiKey.trim() ? { geminiApiKey: geminiKey.trim() } : {}),
        }),
      });
      setKey("");
      setGeminiKey("");
      onSave(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="AIの接続設定"
      subtitle="文字起こしと議事録に使うAIを設定します。"
      onClose={onClose}
      locked={busy}
    >
      <form onSubmit={submit} className="ai-settings-form">
        <div className="api-connections">
          <details
            className="api-connection"
            open={openAiExpanded}
            onToggle={(e) => setOpenAiExpanded(e.currentTarget.open)}
          >
            <summary>
              <KeyRound size={18} />
              <strong>OpenAI API</strong>
              <span
                className={`api-connection-status ${settings?.configured ? "configured" : ""}`}
              >
                {settings?.configured && <Check size={14} />}
                {settings?.configured ? "設定済み" : "未設定"}
              </span>
              <ChevronDown size={16} className="api-connection-chevron" />
            </summary>
            <div className="api-connection-body">
              <label className="field">
                APIキー
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={
                    settings?.configured ? "変更する場合のみ入力" : "sk-…"
                  }
                  minLength={20}
                  required={!settings?.configured}
                  disabled={busy}
                  onInvalid={(e) => revealInvalidKey(e, "openai")}
                />
                <span className="field-hint">
                  {isCloud
                    ? "キーはこのワークスペース共通で暗号化保存し、画面には再表示しません。ログインした全員がこのキーで解析を実行します。他アプリのキーとは共用しません。"
                    : "キーはサーバーのメモリにだけ保持し、画面には再表示しません。再起動時は再設定が必要です。"}
                </span>
              </label>
            </div>
          </details>
          <details
            className="api-connection"
            open={geminiExpanded}
            onToggle={(e) => setGeminiExpanded(e.currentTarget.open)}
          >
            <summary>
              <KeyRound size={18} />
              <strong>Google Gemini API</strong>
              <span
                className={`api-connection-status ${settings?.geminiConfigured ? "configured" : ""}`}
              >
                {settings?.geminiConfigured && <Check size={14} />}
                {settings?.geminiConfigured ? "設定済み" : "未設定"}
              </span>
              <ChevronDown size={16} className="api-connection-chevron" />
            </summary>
            <div className="api-connection-body">
              <label className="field">
                Gemini APIキー
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                  placeholder={
                    settings?.geminiConfigured
                      ? "変更する場合のみ入力"
                      : "AIza…"
                  }
                  minLength={20}
                  disabled={busy}
                  onInvalid={(e) => revealInvalidKey(e, "gemini")}
                  required={
                    transcriptionModel === "gemini-3.5-transcribe" &&
                    !settings?.geminiConfigured
                  }
                />
                <span className="field-hint">
                  Geminiを選んだ場合のみ音声をGoogleへ送信します。Geminiで文字起こしが完了しなかった録音は、自動でGPT
                  Transcribeに切り替えます（その録音の音声はOpenAIにも送信されます）。キーはOpenAIキーとは別に保存します。
                </span>
              </label>
            </div>
          </details>
        </div>
        <fieldset className="model-options">
          <legend>文字起こし</legend>
          {[
            {
              id: "gpt-transcribe",
              title: "GPT Transcribe",
              detail: "OpenAIの最新モデルで録音を文字にする",
              Icon: Zap,
            },
            {
              id: "gemini-3.5-transcribe",
              title: "Gemini 3.5 Transcribe",
              detail: "Google Geminiで音声を文字にする",
              Icon: Sparkles,
            },
          ].map(({ id, title, detail, Icon }) => (
            <label
              key={id}
              className={transcriptionModel === id ? "chosen" : ""}
            >
              <input
                type="radio"
                name="transcriptionModel"
                value={id}
                checked={transcriptionModel === id}
                onChange={() => {
                  setTranscriptionModel(id);
                  if (
                    id === "gemini-3.5-transcribe" &&
                    !settings?.geminiConfigured
                  )
                    setGeminiExpanded(true);
                }}
              />
              <Icon size={22} />
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
                <code>{id}</code>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="model-options">
          <legend>会話解析・議事録</legend>
          {[
            {
              id: "gpt-6-astra",
              title: "GPT-6 Astra",
              detail: "複雑な議論を、丁寧に読み解く",
              Icon: Sparkles,
            },
            {
              id: "gpt-6-sol",
              title: "GPT-6 Sol",
              detail: "日々の会議を、効率よく整理する",
              Icon: Zap,
            },
            {
              id: "gpt-6-luna",
              title: "GPT-6 Luna",
              detail: "費用を抑えて、会議を手早く整理する",
              Icon: Zap,
            },
          ].map(({ id, title, detail, Icon }) => (
            <label key={id} className={model === id ? "chosen" : ""}>
              <input
                type="radio"
                name="model"
                value={id}
                checked={model === id}
                onChange={() => setModel(id)}
              />
              <Icon size={22} />
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
                <code>{id}</code>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="model-options">
          <legend>通知設定</legend>
          <label className="chosen">
            <Bell size={22} />
            <span>
              <strong>確定した期限のリマインダー</strong>
              <small>
                アプリを開いている間、共有カレンダーの確定済み期限を通知します。同じ期限はこのタブで一度だけ通知します。
              </small>
              <span className="notification-status">
                {notificationPermission === "granted"
                  ? "有効"
                  : notificationPermission === "denied"
                    ? "無効"
                    : "未設定"}
              </span>
            </span>
            {notificationPermission !== "granted" && (
              <button
                type="button"
                className="button secondary small"
                onClick={onRequestNotification}
              >
                有効にする
              </button>
            )}
          </label>
        </fieldset>
        <p className="field-hint">
          モデルの利用可否はAPI実行時に確認されます。ChatGPTの契約とは別にAPIの利用枠が必要です。
        </p>
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            キャンセル
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}設定を保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
