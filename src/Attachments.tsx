import { useEffect, useRef, useState } from "react";
import { Paperclip, Download, Eye, LoaderCircle, X, FileText, Image as ImageIcon, UploadCloud } from "lucide-react";
import {
  attachmentTypes,
  isImageAttachment,
  validateAttachments,
} from "../supabase/functions/_shared/attachments.mjs";
import { api } from "./api";
import { isCloud } from "./cloud";
import { AttachmentViewer } from "./AttachmentViewer";
import { previewKind } from "./attachment-preview.mjs";
import type { Attachment, Meeting } from "./types";

const fileSize = (bytes: number) =>
  bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} KB`
    : `${(bytes / 1_000_000).toFixed(2)} MB`;

export function AttachmentNotice() {
  return (
    <p className="field-hint attachment-notice">
      資料は会議の参考資料として保存・共有するだけで、AIには送信せず、議事録の解析にも使いません。
    </p>
  );
}
export function AttachmentPicker({
  files,
  onChange,
  disabled = false,
  existing = [],
  layout = "form",
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  existing?: Attachment[];
  layout?: "form" | "dropzone";
}) {
  const input = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  function addFiles(incoming: FileList | null) {
    if (disabled || !incoming?.length) return;
    const selected = [...files, ...Array.from(incoming)];
    try {
      validateAttachments([...existing, ...selected]);
      onChange(selected);
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <div
      className={`attachment-picker ${layout} ${dragging && !disabled ? "drag" : ""}`}
      onDragEnter={(event) => {
        if (disabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (disabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      {layout === "dropzone" ? (
        <div className="attachment-dropzone">
          <UploadCloud size={22} />
          <strong>資料をドラッグ＆ドロップ</strong>
          <button
            type="button"
            className="button secondary small"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            ファイルを選択
          </button>
          <p className="field-hint">
            Excel・Word・PDF・PowerPoint・CSV・TXT・画像 ／
            最大5ファイル・各10 MB・合計25 MB
          </p>
        </div>
      ) : (
        <>
          <div className="attachment-heading">
            <strong>
              <Paperclip size={17} />
              会議の添付資料 <span className="optional">任意</span>
            </strong>
            <button
              type="button"
              className="button secondary small"
              disabled={disabled}
              onClick={() => input.current?.click()}
            >
              資料ファイルを選択
            </button>
          </div>
          <p className="field-hint">
            Excel・Word・PDF・PowerPoint・CSV・TXT・画像（JPEG・PNG・GIF・WebP・HEIC） ／ 最大5ファイル・各10 MB・合計25
            MB（録音とは別枠）
          </p>
          <div className="attachment-drop-hint">
            <UploadCloud size={19} />
            <span>資料をここにドラッグ＆ドロップ、または上のボタンから選択</span>
          </div>
        </>
      )}
      <input
        hidden
        type="file"
        ref={input}
        accept={Object.keys(attachmentTypes).join(",")}
        multiple
        disabled={disabled}
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {files.map((file, index) => (
        <div className="attachment-row" key={`${index}-${file.name}`}>
          {isImageAttachment(file.name) ? <ImageIcon size={18} /> : <FileText size={18} />}
          <span className="attachment-name">
            {file.name}
            <small>{fileSize(file.size)}</small>
          </span>
          <button
            type="button"
            className="icon-button"
            disabled={disabled}
            aria-label={`${file.name}の選択を解除`}
            onClick={() => {
              onChange(files.filter((_, i) => i !== index));
              setError("");
            }}
          >
            <X size={16} />
          </button>
        </div>
      ))}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {layout === "form" && <AttachmentNotice />}
    </div>
  );
}

export function AttachmentPanel({
  meeting,
  locked,
  onChange,
  onBusyChange,
  notify,
  dropped = null,
}: {
  meeting: Meeting;
  locked: boolean;
  onChange: (m: Meeting) => void;
  onBusyChange: (v: boolean) => void;
  notify: (s: string) => void;
  /** Files dropped elsewhere on the meeting screen. */
  dropped?: { files: File[]; id: number } | null;
}) {
  const [files, setFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<string | null>(null),
    [error, setError] = useState(""),
    [viewing, setViewing] = useState<Attachment | null>(null);
  const saved = meeting.attachments || [];
  // Runs once per drop, not on later meeting updates.
  useEffect(() => {
    if (!dropped?.files.length || locked || busy || meeting.isDemo) return;
    const selected = [...files, ...dropped.files];
    try {
      validateAttachments([...saved, ...selected]);
      setFiles(selected);
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }, [dropped?.id]);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  async function save() {
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      validateAttachments([...saved, ...files]);
      for (const file of files) {
        const form = new FormData();
        form.set("id", crypto.randomUUID());
        form.set("attachment", file);
        onChange(
          await api<Meeting>(`/meetings/${meeting.id}/attachments`, {
            method: "POST",
            body: form,
          }),
        );
        setFiles((current) => current.slice(1));
      }
      notify("資料を保存しました。");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      onChange(
        await api<Meeting>(`/meetings/${meeting.id}/attachments/${id}`, {
          method: "DELETE",
        }),
      );
      setConfirm(null);
      notify("資料の関連付けを解除しました。");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  async function download(file: Attachment) {
    try {
      const route = `/meetings/${meeting.id}/attachments/${file.id}`;
      const url = isCloud
        ? (await api<{ url: string }>(route)).url
        : `/api${route}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.rel = "noopener noreferrer";
      a.click();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <section className="attachment-panel" aria-label="保存した添付資料">
      {meeting.isDemo && !saved.length && (
        <p className="field-hint">
          サンプルには資料を追加できません。実際の会議で資料を保存し、あとからダウンロードできます。
        </p>
      )}
      {saved.map((file) => (
        <div className="attachment-item" key={file.id}>
          <div className="attachment-row">
            {isImageAttachment(file.name) ? <ImageIcon size={19} /> : <FileText size={19} />}
            <span className="attachment-name">
              {previewKind(file.name) ? (
                <button
                  type="button"
                  className="attachment-open"
                  disabled={busy}
                  onClick={() => setViewing(file)}
                >
                  {file.name}
                </button>
              ) : (
                file.name
              )}
              <small>{fileSize(file.size)}</small>
            </span>
            {previewKind(file.name) && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setViewing(file)}
              >
                <Eye size={15} />
                表示
              </button>
            )}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void download(file)}
            >
              <Download size={15} />
              ダウンロード
            </button>
            <button
              className="icon-button"
              aria-label={`${file.name}の関連付けを解除`}
              disabled={locked || busy}
              onClick={() => setConfirm(file.id)}
            >
              <X size={16} />
            </button>
          </div>
          {confirm === file.id && (
            <div className="notice">
              この会議の資料一覧から外します。保存ファイルは保持され、管理者による復元が可能です。
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setConfirm(null)}
              >
                取消
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void remove(file.id)}
              >
                関連付けを解除する
              </button>
            </div>
          )}
        </div>
      ))}
      {!meeting.isDemo && (
        <>
          <AttachmentPicker
            files={files}
            onChange={setFiles}
            disabled={locked || busy}
            existing={saved}
            layout="dropzone"
          />
          {!!files.length && (
            <button
              className="button secondary small"
              disabled={locked || busy}
              onClick={() => void save()}
            >
              {busy && <LoaderCircle size={16} className="spin" />}
              選択した資料を保存
            </button>
          )}
        </>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="attachment-footnote">
        <span>AIには送信せず、議事録の解析にも使いません。</span>
        <span>{isCloud ? "ログインした全員で共有" : "このPCに保存"}</span>
      </div>
      {viewing && (
        <AttachmentViewer
          meeting={meeting}
          file={viewing}
          onClose={() => setViewing(null)}
          onDownload={() => void download(viewing)}
        />
      )}
    </section>
  );
}
