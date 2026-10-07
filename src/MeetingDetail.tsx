import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  Clipboard,
  Clock3,
  Download,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Users,
  X,
  Lightbulb,
} from "lucide-react";
import { meetingEvents } from "../supabase/functions/_shared/calendar.mjs";
import { BotStatus } from "./BotStatus";
import { api, download, audioUrl } from "./api";
import {
  clock,
  isWorking,
  modelName,
  transcriptionModelName,
  type Meeting,
} from "./types";
import { Modal } from "./Modal";
import { MinutesFormatField } from "./MinutesFormatField";
import { MinutesMarkdown as Markdown } from "./MinutesMarkdown.mjs";
import { minutesFormat } from "../supabase/functions/_shared/minutes-formats.mjs";
import { AttachmentPanel } from "./Attachments";
import { MeetingSchedule } from "./Calendar";
import {
  speakerTurns,
  transcriptParagraphs,
} from "./transcript-paragraphs.mjs";

type Tab = "minutes" | "transcript" | "actions" | "schedule" | "files";
const tabLabels: Record<Tab, string> = {
  minutes: "議事録",
  transcript: "文字起こし",
  actions: "アクション",
  schedule: "予定・期限",
  files: "添付資料",
};
const hasFiles = (event: { dataTransfer: DataTransfer }) =>
  event.dataTransfer.types.includes("Files");

export function ActionList({
  meeting,
  onChange,
  notify,
  disabled = false,
}: {
  meeting: Meeting;
  onChange: (m: Meeting) => void;
  notify: (s: string) => void;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const actions = meeting.minutes?.actions || [];
  const completedActions = meeting.completedActions || [];
  
  // 期限切れチェック
  const isOverdue = (due: string) => {
    if (!due) return false;
    const dueDate = new Date(due);
    if (isNaN(dueDate.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return dueDate < today;
  };

  // 優先度のラベルと色
  const priorityConfig = {
    high: { label: "高", className: "priority-high" },
    medium: { label: "中", className: "priority-medium" },
    low: { label: "低", className: "priority-low" },
  };

  async function toggle(index: number) {
    setSaving(true);
    try {
      const complete = new Set(completedActions);
      if (complete.has(index)) complete.delete(index);
      else complete.add(index);
      onChange(
        await api<Meeting>(`/meetings/${meeting.id}`, {
          method: "PATCH",
          body: JSON.stringify({ completedActions: [...complete] }),
        }),
      );
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="action-list">
      {actions.length ? (
        actions.map((action, i) => {
          const overdue = !completedActions.includes(i) && isOverdue(action.due);
          const priority = action.priority || "medium";
          const priorityInfo = priorityConfig[priority];
          
          return (
            <div
              className={`action-item ${completedActions.includes(i) ? "completed" : ""} ${overdue ? "overdue" : ""}`}
              key={i}
            >
              <button
                className="task-checkbox"
                disabled={disabled || saving || isWorking(meeting)}
                role="checkbox"
                aria-checked={completedActions.includes(i)}
                aria-label={`${action.task}を${completedActions.includes(i) ? "未完了" : "完了"}にする`}
                onClick={() => toggle(i)}
              >
                {completedActions.includes(i) && <Check size={13} />}
              </button>
              <div>
                <strong>{action.task}</strong>
                <div className="action-meta">
                  <span className="person-dot">
                    {action.owner.slice(0, 1) || "?"}
                  </span>
                  {action.owner || "未定"}
                  <span className={`action-priority ${priorityInfo.className}`}>
                    {priorityInfo.label}
                  </span>
                  {action.category && (
                    <span className="action-category">{action.category}</span>
                  )}
                  <span className={`action-due ${overdue ? "overdue" : ""}`}>
                    <CalendarDays size={12} />
                    {action.due || "未定"}
                    {overdue && " (期限切れ)"}
                  </span>
                </div>
              </div>
            </div>
          );
        })
      ) : (
        <p className="muted empty-inline">アクションアイテムはありません。</p>
      )}
    </div>
  );
}

export function MeetingDetail({
  meeting: m,
  onBack,
  backLabel,
  onCalendar,
  onRename,
  onChooseTags,
  onChange,
  onDelete,
  notify,
  onEditingChange,
}: {
  meeting: Meeting;
  onBack: () => void;
  backLabel: string;
  onCalendar: (date?: string) => void;
  onRename: (meeting: Meeting) => void;
  onChooseTags: (meeting: Meeting) => void;
  onChange: (m: Meeting) => void;
  onDelete: (id: string) => void;
  notify: (s: string) => void;
  onEditingChange: (value: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("minutes");
  const [dropped, setDropped] = useState<{ files: File[]; id: number } | null>(
    null,
  );
  const [showDecisions, setShowDecisions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "regenerate" | null>(null);
  const [retryTemplate, setRetryTemplate] = useState<Meeting["template"]>(m.template);
  const audio = useRef<HTMLAudioElement>(null);
  const [audioSource, setAudioSource] = useState("");
  const [audioPart, setAudioPart] = useState(0);
  const [now, setNow] = useState(Date.now());
  const wait = m.status === "transcribing" ? m.transcriptionWait : null;
  const waitSeconds = wait
    ? Math.max(0, Math.ceil((Date.parse(wait.until) - now) / 1000))
    : 0;
  const waitLabel = `${waitSeconds >= 60 ? `${Math.floor(waitSeconds / 60)}分` : ""}${waitSeconds % 60}秒`;
  useEffect(() => {
    if (!wait) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [wait?.until]);
  const recordings = m.recordings?.length
    ? m.recordings
    : [{ fileName: m.fileName || "録音", transcribed: Boolean(m.transcript) }];
  useEffect(() => {
    // On narrow screens the tab row scrolls; keep the selected tab visible.
    document
      .getElementById(`meeting-tab-${tab}`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  useEffect(() => {
    onEditingChange(editing || attachmentsBusy || busy);
    return () => onEditingChange(false);
  }, [editing, attachmentsBusy, busy, onEditingChange]);
  useEffect(() => {
    if (!m.hasAudio || tab !== "transcript") return;
    let alive = true;
    setAudioSource("");
    void audioUrl(m.id, audioPart)
      .then((url) => {
        if (alive) setAudioSource(url);
      })
      .catch((e) => {
        if (alive) notify(e.message);
      });
    return () => {
      alive = false;
    };
  }, [m.id, m.hasAudio, tab, notify, audioPart]);
  const processing = isWorking(m);
  useEffect(() => {
    if (!editing) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [editing]);
  function beginEdit() {
    setDraft(tab === "minutes" ? m.markdown : m.transcript);
    setEditing(true);
  }
  async function save() {
    setBusy(true);
    try {
      onChange(
        await api<Meeting>(`/meetings/${m.id}`, {
          method: "PATCH",
          body: JSON.stringify(
            tab === "minutes" ? { markdown: draft } : { transcript: draft },
          ),
        }),
      );
      setEditing(false);
      notify("変更を保存しました。全員の共有内容に反映されます。");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function regenerate() {
    setBusy(true);
    try {
      onChange(
        await api<Meeting>(`/meetings/${m.id}/retry`, {
          method: "POST",
          body: confirm === "regenerate" ? JSON.stringify({ template: retryTemplate }) : undefined,
        }),
      );
      setConfirm(null);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api(`/meetings/${m.id}`, { method: "DELETE" });
      onDelete(m.id);
      notify("会議をゴミ箱に移動しました");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  
  const displayText = tab === "transcript" ? m.transcript : m.markdown;
  const turns = m.segments.length ? null : speakerTurns(m.transcript);
  const tabs: Tab[] = m.isDemo
    ? ["minutes", "transcript", "actions", "files"]
    : ["minutes", "transcript", "actions", "schedule", "files"];
  const counts: Partial<Record<Tab, number>> = {
    actions: m.minutes?.actions.length || 0,
    schedule: m.isDemo ? 0 : meetingEvents(m).length,
    files: m.attachments?.length || 0,
  };
  const attachmentsLocked =
    processing || editing || busy || m.status === "uploading";
  const canDropFiles = !m.isDemo && !attachmentsLocked && !attachmentsBusy;
  const fallbackParts = recordings.flatMap((part, index) =>
    "fallbackModel" in part && part.transcribed ? [index + 1] : [],
  );
  const fallbackDetail = `${fallbackParts.map((n) => `録音${n}`).join("・")}はGeminiで文字起こしが完了しなかったため、GPT Transcribeで文字起こししました。この録音の音声はOpenAIにも送信されています。`;
  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? tabs[(index + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs[tabs.length - 1]
              : null;
    if (!next || editing) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`meeting-tab-${next}`)?.focus();
  }
  return (
    <div
      className="meeting-detail"
      onDragEnter={(event) => {
        if (canDropFiles && hasFiles(event)) setTab("files");
      }}
      onDragOver={(event) => {
        if (!canDropFiles || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        // Files dropped outside the attachment drop zone still go to the
        // attachment tab instead of making the browser open the file.
        if (!canDropFiles || !hasFiles(event) || event.isDefaultPrevented())
          return;
        event.preventDefault();
        setTab("files");
        setDropped({
          files: Array.from(event.dataTransfer.files),
          id: Date.now(),
        });
      }}
    >
      <div className="detail-top">
        <button
          className="text-button"
          disabled={editing || attachmentsBusy}
          onClick={onBack}
        >
          <ArrowLeft size={16} />
          {backLabel}
        </button>
        <div className="detail-tools">
          <span className="autosave">
            <Check size={13} />
            {editing ? "編集中・未保存" : "保存済み"}
          </span>
          <details className="export-menu">
            <summary className="button secondary small">
              <Download size={15} />
              書き出す
              <ChevronDown size={13} />
            </summary>
            <div>
              {[
                [
                  "議事録（Markdown）",
                  () => download(`${m.title}.md`, m.markdown),
                ],
                [
                  "文字起こし（テキスト）",
                  () => download(`${m.title}_文字起こし.txt`, m.transcript),
                ],
                [
                  "すべてのデータ（JSON）",
                  () =>
                    download(
                      `${m.title}.json`,
                      JSON.stringify(m, null, 2),
                      "application/json",
                    ),
                ],
                ["印刷・PDFに保存", () => window.print()],
              ].map(([label, run]) => (
                <button
                  key={label as string}
                  onClick={(e) => {
                    (run as () => void)();
                    e.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  {label as string}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
      <header className="meeting-heading">
        <div className="eyebrow">
          <span
            className={`badge ${m.isDemo ? "sample" : m.status === "done" ? "success" : "neutral"}`}
          >
            {m.isDemo
              ? "サンプル会議"
              : m.status === "done"
                ? "作成完了"
                : m.status === "error"
                  ? "要確認"
                  : m.status === "uploading"
                    ? "取り込み途中"
                    : m.status === "bot"
                      ? "Bot録音"
                      : "AI処理中"}
          </span>
          <span>MEETING NOTES</span>
        </div>
        <div className="meeting-title-row">
          <h1>{m.title}</h1>
          <button
            className="button secondary small"
            disabled={processing || busy || editing || attachmentsBusy}
            onClick={() => onRename(m)}
            aria-label="会議名を変更"
          >
            <Pencil size={14} /> 名前を変更
          </button>
        </div>
        <div className="meeting-meta">
          <span>
            <CalendarDays size={15} />
            {m.date.replaceAll("-", ".")}
          </span>
          <span>
            <Users size={15} />
            {m.participants || "参加者未記入"}
          </span>
          {m.duration !== null && (
            <span>
              <Clock3 size={15} />
              {clock(m.duration)}
            </span>
          )}
          {fallbackParts.length > 0 && (
            <span className="meta-fallback" title={fallbackDetail}>
              文字起こし：
              {recordings.length > 1
                ? `${fallbackParts.map((n) => `録音${n}`).join("・")}は`
                : ""}
              GPT Transcribe（Gemini失敗のため切替）
              <span className="sr-only">{fallbackDetail}</span>
            </span>
          )}
        </div>
      </header>
      {m.isDemo && (
        <div className="sample-note">
          <Sparkles size={15} />
          操作確認用の架空の会議です。実際の録音を解析した結果ではありません。
        </div>
      )}
      {m.status === "uploading" && !m.bot && (
        <div className="notice" role="status">
          音声の取り込み途中です。送信中の画面で完了をお待ちください。送信を中断した場合は、この会議を削除してファイルを選び直してください。
        </div>
      )}
      {m.bot && <BotStatus meeting={m} onChange={onChange} />}
      {processing && (
        <div className="progress-panel" role="status">
          <LoaderCircle className="spin" size={23} />
          <div>
            <strong>
              {wait
                ? wait.reason === "rate_limit"
                  ? "Geminiの利用制限により待機しています"
                  : "次の録音を送信するまで待機しています"
                : m.status === "transcribing"
                  ? `録音を文字起こししています${recordings.length > 1 ? `（${recordings.filter((part) => part.transcribed).length}/${recordings.length} 完了）` : ""}`
                  : "会話を解析して議事録を作成しています"}
            </strong>
            <p>
              {wait
                ? `${waitSeconds > 0 ? `自動再開まで約${waitLabel}。` : "順番を確認し、自動再開しています。"} ${recordings.filter((part) => part.transcribed).length}/${recordings.length} 完了。${wait.reason === "rate_limit" && wait.attempt ? ` 自動再試行 ${wait.attempt}/5。` : ""}`
                : m.status === "transcribing"
                  ? `${transcriptionModelName(m.transcriptionModel)}が音声を読み取っています。`
                  : `${modelName(m.minutesModel)}が議題・決定事項・アクションを整理しています。`}{" "}
              完了分は保存されます。アプリを閉じても、残りの処理はサーバーで自動的に続きます。
            </p>
          </div>
        </div>
      )}
      {m.error && (
        <div className="error-message detail-error" role="alert">
          <span>{m.error}</span>
          <button
            className="button secondary small"
            onClick={regenerate}
            disabled={busy}
          >
            <RefreshCw size={14} />
            再試行
          </button>
        </div>
      )}
      {m.minutesStale && (
        <div className="notice">
          文字起こしが変更されています。現在の議事録は変更前の内容です。反映するには「再生成」を実行してください。
        </div>
      )}
      <div className="detail-grid">
        <section className="document-panel">
          <div
            className="document-tabs"
            role="tablist"
            aria-label="会議の内容"
            onKeyDown={onTabKey}
          >
            {tabs.map((id) => (
              <button
                key={id}
                id={`meeting-tab-${id}`}
                role="tab"
                aria-selected={tab === id}
                aria-controls={`meeting-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                disabled={editing && tab !== id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {tabLabels[id]}
                {id in counts && (
                  <span className="tab-count">{counts[id]}</span>
                )}
              </button>
            ))}
          </div>
          {(tab === "minutes" || tab === "transcript") &&
            (displayText || m.minutes || editing) && (
              <div className="document-toolbar">
                {editing ? (
                  <>
                    <button
                      className="button ghost small"
                      onClick={() => {
                        if (
                          draft === displayText ||
                          window.confirm(
                            "保存していない本文の変更を破棄しますか？",
                          )
                        )
                          setEditing(false);
                      }}
                      disabled={busy}
                    >
                      <X size={14} />
                      取消
                    </button>
                    <button
                      className="button primary small"
                      onClick={save}
                      disabled={busy || (tab === "transcript" && !draft.trim())}
                    >
                      <Save size={14} />
                      保存
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="button ghost small"
                      onClick={() =>
                        navigator.clipboard
                          .writeText(displayText)
                          .then(() => notify("コピーしました"))
                          .catch(() =>
                            notify(
                              "コピーできませんでした。書き出しをご利用ください。",
                            ),
                          )
                      }
                    >
                      <Clipboard size={14} />
                      コピー
                    </button>
                    <button
                      className="button secondary small"
                      onClick={beginEdit}
                      disabled={processing || attachmentsBusy}
                    >
                      <Pencil size={14} />
                      {tab === "minutes" ? "議事録を編集" : "文字起こしを編集"}
                    </button>
                  </>
                )}
              </div>
            )}
          {tab !== "files" && (
            <div
              className="tab-panel"
              role="tabpanel"
              id={`meeting-panel-${tab}`}
              aria-labelledby={`meeting-tab-${tab}`}
            >
              {editing ? (
                <div className="editor-wrap">
                  <p>
                    {tab === "minutes"
                      ? "見出しは「## 」、箇条書きは「- 」で記入できます。「保存」で全員に共有します。カレンダー・AI抽出の要点・決定事項・アクションは別管理のため、本文の変更は自動反映しません。再生成すると編集した本文は上書きされます。"
                      : "文字起こしの修正後、議事録を再生成できます。"}
                  </p>
                  <textarea
                    className="document-editor"
                    aria-label={
                      tab === "minutes" ? "議事録を編集" : "文字起こしを編集"
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={tab === "minutes" ? 150000 : 100000}
                  />
                </div>
              ) : tab === "minutes" ? (
                m.markdown ? (
                  <Markdown content={m.markdown} title={m.title} />
                ) : (
                  <div className="document-empty">
                    <FileText size={36} />
                    <h3>
                      {processing
                        ? "議事録を準備しています"
                        : "議事録はまだありません"}
                    </h3>
                    <p>解析が完了すると、ここに議事録が表示されます。</p>
                  </div>
                )
              ) : tab === "transcript" ? (
                <div className="transcript-content">
                  {m.hasAudio && (
                    <>
                      {recordings.length > 1 && (
                        <label className="field">
                          再生する録音（全{recordings.length}ファイル）
                          <select
                            value={audioPart}
                            onChange={(e) =>
                              setAudioPart(Number(e.target.value))
                            }
                          >
                            {recordings.map((part, index) => (
                              <option key={index} value={index}>
                                {index + 1}. {part.fileName}
                                {part.transcribed ? "" : "（文字起こし未完了）"}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <audio
                        key={`${m.id}-${audioPart}`}
                        ref={audio}
                        controls
                        src={audioSource || undefined}
                        preload="metadata"
                      />
                    </>
                  )}
                  {m.segments.length ? (
                    m.segments.map((s, i) => (
                      <div className="transcript-segment" key={i}>
                        <div>
                          <span className={`speaker-avatar color-${i % 3}`}>
                            {s.speaker.slice(0, 1)}
                          </span>
                          <strong>
                            {m.speakerNames[s.speaker] || s.speaker}
                          </strong>
                          {s.start !== null && (
                            <span className="time-code">{clock(s.start)}</span>
                          )}
                        </div>
                        <p>{s.text}</p>
                      </div>
                    ))
                  ) : m.transcript && turns ? (
                    <>
                      <p className="transcript-note">
                        {transcriptionModelName(m.transcriptionModel)}
                        が声の違いから話者を推定しています。録音が10分ごとに分割されている場合、分割した部分をまたぐと同じ人でも別の話者番号になることがあります。
                      </p>
                      {turns.map((t, i) =>
                        "heading" in t ? (
                          <h3 className="transcript-heading" key={i}>
                            {t.heading}
                          </h3>
                        ) : (
                          <div className="transcript-segment" key={i}>
                            {t.speaker && (
                              <div>
                                <span
                                  className={`speaker-avatar color-${
                                    (Number(t.speaker.replace(/\D/g, "")) + 2) %
                                    3
                                  }`}
                                >
                                  {t.speaker.replace(/\D/g, "")}
                                </span>
                                <strong>{t.speaker}</strong>
                                {t.start !== null && (
                                  <span className="time-code">
                                    {clock(t.start)}
                                  </span>
                                )}
                              </div>
                            )}
                            {transcriptParagraphs(t.text).map((p, j) => (
                              <p key={j}>{p}</p>
                            ))}
                          </div>
                        ),
                      )}
                    </>
                  ) : m.transcript ? (
                    <>
                      {m.source === "audio" && (
                        <p className="transcript-note">
                          {transcriptionModelName(m.transcriptionModel)}
                          の出力です。話者名・タイムスタンプは付与していません。読みやすさのため文の区切りで段落に分けて表示しています。
                        </p>
                      )}
                      <div className="transcript-text">
                        {transcriptParagraphs(m.transcript).map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="document-empty">
                      <MessageSquareText size={32} />
                      <p>文字起こしの完了をお待ちください。</p>
                    </div>
                  )}
                </div>
              ) : tab === "actions" ? (
                <div className="actions-content">
                  <ActionList
                    meeting={m}
                    onChange={onChange}
                    notify={notify}
                    disabled={editing || busy || attachmentsBusy}
                  />
                </div>
              ) : (
                <MeetingSchedule
                  meeting={m}
                  onOpen={onCalendar}
                  disabled={editing || attachmentsBusy || busy}
                />
              )}
            </div>
          )}
          {/* Stay mounted so selected files and uploads survive tab changes. */}
          <div
            className="tab-panel"
            role="tabpanel"
            id="meeting-panel-files"
            aria-labelledby="meeting-tab-files"
            hidden={tab !== "files"}
          >
            <AttachmentPanel
              meeting={m}
              locked={attachmentsLocked}
              onChange={onChange}
              onBusyChange={setAttachmentsBusy}
              notify={notify}
              dropped={dropped}
            />
          </div>
        </section>
        <aside className="meeting-rail">
          <section>
            <h3>
              会議のポイント<span>AI抽出</span>
            </h3>
            <p>
              {m.minutes?.summary ||
                "解析後に、会議の要点がここにまとまります。"}
            </p>
          </section>
          {!m.isDemo && m.status === "done" && m.minutes && (
            <section>
              <h3>
                AIタグ提案<span>提案</span>
              </h3>
              <button
                className="button secondary small"
                onClick={() => onChooseTags(m)}
                disabled={busy || editing || attachmentsBusy}
              >
                <Lightbulb size={14} />
                タグ候補を開く
              </button>
              <p className="muted">解析完了後に候補を自動表示します。閉じた場合もここから選べます。選択後に保存すると会議に紐付きます。</p>
              {!!m.tags?.length && <p>登録済み：{m.tags.join("、")}</p>}
            </section>
          )}
          <div className="rail-counts">
            <button
              className="rail-row"
              aria-expanded={showDecisions}
              disabled={!m.minutes?.decisions.length}
              onClick={() => setShowDecisions((open) => !open)}
            >
              <span>決まったこと</span>
              <span>
                {m.minutes?.decisions.length || 0}
                {!!m.minutes?.decisions.length && (
                  <ChevronDown
                    size={14}
                    className={showDecisions ? "open" : ""}
                  />
                )}
              </span>
            </button>
            {showDecisions && !!m.minutes?.decisions.length && (
              <ul className="decision-list">
                {m.minutes.decisions.map((d, i) => (
                  <li key={i}>
                    <Check size={13} />
                    {d}
                  </li>
                ))}
              </ul>
            )}
            <button
              className="rail-row"
              disabled={editing}
              onClick={() => {
                setTab("actions");
                document.getElementById("meeting-tab-actions")?.focus();
              }}
            >
              <span>次のアクション</span>
              <span>
                {m.minutes?.actions.length || 0}
                <ArrowRight size={14} />
              </span>
            </button>
          </div>
          <div className="rail-models">
            <p>
              <span>議事録の詳しさ（解析設定）</span>
              {minutesFormat(m.template).label}
            </p>
            <p>
              <span>解析モデル</span>
              {m.isDemo ? "サンプルデータ" : modelName(m.minutesModel)}
            </p>
            <p>
              <span>文字起こし</span>
              {m.hasAudio
                ? transcriptionModelName(m.transcriptionModel)
                : "文字起こし済みテキスト"}
            </p>
            <small>
              AIの出力は元の会話と照合し、必要に応じて編集してください。
            </small>
          </div>
          <div className="rail-manage">
            {!m.isDemo && (
              <button
                className="text-button purple"
                disabled={
                  processing ||
                  busy ||
                  editing ||
                  attachmentsBusy ||
                  m.status === "uploading"
                }
                onClick={() => {
                  setRetryTemplate(m.template);
                  setConfirm("regenerate");
                }}
              >
                <RefreshCw size={13} />
                詳しさを変えて再生成
              </button>
            )}
            <button
              className="text-button delete-button"
              disabled={processing || busy || editing || attachmentsBusy}
              onClick={() => setConfirm("delete")}
            >
              <Trash2 size={13} />
              会議を削除
            </button>
          </div>
        </aside>
      </div>
      {confirm && (
        <Modal
          title={
            confirm === "delete"
              ? "この会議を削除しますか？"
              : "議事録を再生成しますか？"
          }
          onClose={() => setConfirm(null)}
          locked={busy}
        >
          {confirm === "regenerate" && (
            <MinutesFormatField value={retryTemplate} onChange={setRetryTemplate} disabled={busy} />
          )}
          <p className="confirm-copy">
            {confirm === "delete"
              ? m.status === "uploading"
                ? "取り込み途中の会議を一覧から取り除きます。クラウドに送信済みの未完了音声は完全に削除され、元に戻せません。元の録音ファイルから再度取り込めます。"
                : "会議と音声を一覧から取り除き、アプリの保存先にあるゴミ箱へ移動します。"
              : "選んだ詳しさと接続設定のモデルで再解析します。保存済みの文字起こしは再利用し、未完了の音声がある場合のみ文字起こしを行います。添付資料は解析に使いません。編集した議事録本文とアクションの完了状態は上書きされます。カレンダーの手動変更と既存のタグは保持します。"}
          </p>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => setConfirm(null)}
              disabled={busy}
            >
              キャンセル
            </button>
            <button
              className={`button ${confirm === "delete" ? "danger" : "primary"}`}
              disabled={busy}
              onClick={confirm === "delete" ? remove : regenerate}
            >
              {busy && <LoaderCircle size={15} className="spin" />}
              {confirm === "delete" ? "ゴミ箱へ移動" : "再生成する"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
