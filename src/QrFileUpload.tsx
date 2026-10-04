import { useEffect, useRef, useState, type FormEvent } from "react";
import { FileUp, LoaderCircle } from "lucide-react";
import { useQrApi, type QrLink } from "./qr-api";
import { isFileDrag, selectedQrFile } from "./qr-file-selection.mjs";
import {
  fileSpecification,
  matchesFileSignature,
  QR_FILE_ACCEPT,
} from "../supabase/functions/_shared/qr-files.mjs";

function uploadFile(
  url: string,
  file: File,
  mime: string,
  progress: (n: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", mime);
    request.setRequestHeader("x-upsert", "false");
    request.setRequestHeader("cache-control", "max-age=0");
    request.timeout = 180000;
    request.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(
            new Error(
              "アップロード結果を確認できませんでした。同じファイルで再試行してください。",
            ),
          );
    request.onerror = request.ontimeout = () =>
      reject(
        new Error("通信が中断されました。同じファイルで再試行してください。"),
      );
    request.send(file);
  });
}
export function QrFileUpload({
  onCreated,
  onBusy,
  busy,
}: {
  onCreated: (link: QrLink) => void;
  onBusy: (busy: boolean) => void;
  busy: boolean;
}) {
  const qrApi = useQrApi();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const attempt = useRef<{ id: string; file: File; title: string } | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Dropping outside the box must not navigate away from the application.
    const preventFileNavigation = (event: DragEvent) => {
      if (isFileDrag(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", preventFileNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", preventFileNavigation);
    };
  }, []);
  function selectFile(files: FileList | null) {
    if (busy || pending) return;
    setConfirmed(false);
    setError("");
    try {
      const value = selectedQrFile(files);
      setFile(value);
      if (value && !title.trim())
        setTitle(value.name.replace(/\.[^.]+$/, "").slice(0, 120));
    } catch (e) {
      setFile(null);
      setError(
        e instanceof Error ? e.message : "ファイルを選択できませんでした。",
      );
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  useEffect(() => {
    if (!busy || !pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy, pending]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !file || !confirmed) return;
    setError("");
    onBusy(true);
    try {
      const spec = fileSpecification(file.name, file.size);
      if (
        !matchesFileSignature(
          spec.mime,
          new Uint8Array(await file.slice(0, 32).arrayBuffer()),
        )
      )
        throw new Error(
          "ファイルの種類が一致しません。正しいPDF・JPG・PNGを選択してください。",
        );
      if (!attempt.current)
        attempt.current = {
          id: crypto.randomUUID(),
          file,
          title: title.trim(),
        };
      setPending(true);
      setStatus("保存先を準備しています…");
      setProgress(0);
      const id = attempt.current.id;
      const prepared = await qrApi<{
        link?: QrLink;
        uploaded?: boolean;
        uploadUrl?: string;
        mime?: string;
      }>("/uploads", {
        method: "POST",
        body: JSON.stringify({
          id,
          title: attempt.current.title,
          ...spec,
          publishConfirmed: true,
        }),
      });
      let link = prepared.link;
      if (!link) {
        if (!prepared.uploaded) {
          if (!prepared.uploadUrl || !prepared.mime)
            throw new Error("保存先を確認できませんでした。");
          setStatus("アップロード中です。画面を閉じないでください。");
          await uploadFile(
            prepared.uploadUrl,
            file,
            prepared.mime,
            setProgress,
          );
        }
        setStatus("ファイルを確認してQRを発行しています…");
        link = await qrApi<QrLink>(`/uploads/${id}/complete`, {
          method: "POST",
        });
      }
      attempt.current = null;
      setPending(false);
      setFile(null);
      setTitle("");
      setConfirmed(false);
      setStatus("");
      if (fileInput.current) fileInput.current.value = "";
      onCreated(link);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "公開結果を確認できませんでした。",
      );
      setStatus("");
    } finally {
      onBusy(false);
    }
  }
  async function discard() {
    if (busy || !attempt.current) return;
    onBusy(true);
    setError("");
    try {
      const id = attempt.current.id;
      await qrApi(`/uploads/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmId: id }),
      });
      attempt.current = null;
      setPending(false);
      setStatus("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "破棄結果を確認できませんでした。",
      );
    } finally {
      onBusy(false);
    }
  }
  return (
    <form className="qr-file-upload" onSubmit={create}>
      <div className="qr-file-intro">
        <FileUp size={24} />
        <div>
          <h2>ファイルを公開してQRを発行</h2>
          <p>
            メニュー・パンフレット・お知らせを、URLの用意なしで配布できます。
          </p>
        </div>
      </div>
      <p className="qr-file-capacity-note">
        合計500MBまで。ドロップしただけでは公開されません。
      </p>
      <div className="qr-file-fields">
        <label>
          管理用の名前
          <input
            required
            maxLength={120}
            value={title}
            disabled={busy || pending}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例：秋のメニュー・店舗案内"
          />
        </label>
        <div className="qr-file-picker">
          <span>公開するファイル</span>
          <div
            className={`qr-file-dropzone ${dragging ? "dragging" : ""} ${busy || pending ? "locked" : ""}`}
            role="group"
            aria-label="ファイルをドラッグ＆ドロップ、または選択"
            aria-disabled={busy || pending}
            onDragEnter={(e) => {
              if (!isFileDrag(e.dataTransfer)) return;
              e.preventDefault();
              if (busy || pending) return;
              dragDepth.current += 1;
              setDragging(true);
            }}
            onDragOver={(e) => {
              if (!isFileDrag(e.dataTransfer)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = busy || pending ? "none" : "copy";
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (dragDepth.current === 0) setDragging(false);
            }}
            onDrop={(e) => {
              if (!isFileDrag(e.dataTransfer)) return;
              e.preventDefault();
              e.stopPropagation();
              dragDepth.current = 0;
              setDragging(false);
              if (busy || pending) return;
              // A dropped file is held in state, not input.files. Clear any old
              // picker value so selecting that same file again still fires change.
              if (fileInput.current) fileInput.current.value = "";
              selectFile(e.dataTransfer.files);
            }}
          >
            <button
              type="button"
              className="qr-file-drop-button"
              disabled={busy || pending}
              onClick={() => fileInput.current?.click()}
            >
              <FileUp size={27} />
              <strong>
                {dragging
                  ? "ここで離してファイルを選択"
                  : "ここにファイルをドラッグ＆ドロップ"}
              </strong>
              <span>またはクリックしてファイルを選ぶ</span>
              <small>PDF・JPG・PNG ／ 1ファイル20MBまで ／ 1つずつ</small>
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={QR_FILE_ACCEPT}
            hidden
            aria-label="公開するファイル"
            disabled={busy || pending}
            onChange={(e) => selectFile(e.target.files)}
          />
        </div>
      </div>
      {file && (
        <p className="qr-file-summary">
          {file.name}（{(file.size / 1024 / 1024).toFixed(2)} MB）
        </p>
      )}
      <label className="qr-public-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={busy}
          required
        />
        <span>
          このファイルを一般公開することを確認しました。QR・リンクを知っている人はログインなしで閲覧・保存できます。個人情報・機密資料は載せないでください。
        </span>
      </label>
      <p className="qr-measure-note">
        停止・ゴミ箱で新しい閲覧を止めます。発行済みの閲覧リンクは最大5分有効で、保存済みのファイルは回収できません。完全削除ではファイル本体も削除します。ウイルス検査は行いません。信頼できるファイルだけを公開してください。
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}{" "}
          {pending &&
            "同じ内容で再試行すると重複発行しません。公開済みの場合は一覧も確認してください。"}
        </p>
      )}
      {status && (
        <div role="status">
          <LoaderCircle size={17} className="spin" /> {status}{" "}
          {status.startsWith("アップロード") && `${progress}%`}
        </div>
      )}
      <div className="qr-file-actions">
        <button
          className="button primary"
          disabled={busy || !file || !confirmed}
        >
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <FileUp size={17} />
          )}
          公開してQRを発行
        </button>
        {pending && !busy && (
          <button
            type="button"
            className="button secondary"
            onClick={() => void discard()}
          >
            未公開のアップロードを破棄
          </button>
        )}
      </div>
    </form>
  );
}
