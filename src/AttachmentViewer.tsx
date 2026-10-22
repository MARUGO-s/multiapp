import { lazy, Suspense, useEffect, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { Modal } from "./Modal";
import { api } from "./api";
import { isCloud } from "./cloud";
import { decodePreviewText, parseCsv, previewKind } from "./attachment-preview.mjs";
import type { Attachment, Meeting } from "./types";

// pdf.js is large; load it only when a PDF is opened.
const PdfPreview = lazy(() =>
  import("./PdfPreview").then((m) => ({ default: m.PdfPreview })),
);

type Loaded =
  | { kind: "image" | "pdf"; url: string }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "csv"; rows: string[][]; truncated: boolean };

async function attachmentBlob(meeting: Meeting, file: Attachment) {
  const route = `/meetings/${meeting.id}/attachments/${file.id}`;
  const url = isCloud ? (await api<{ url: string }>(route)).url : `/api${route}`;
  const response = await fetch(url, { credentials: isCloud ? "omit" : "same-origin" });
  if (!response.ok) throw new Error("資料を読み込めませんでした。");
  // Use the type recorded at upload, not whatever the server sends back.
  return new Blob([await response.arrayBuffer()], { type: file.type });
}

export function AttachmentViewer({
  meeting,
  file,
  onClose,
  onDownload,
}: {
  meeting: Meeting;
  file: Attachment;
  onClose: () => void;
  onDownload: () => void;
}) {
  const kind = previewKind(file.name);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    setLoaded(null);
    setError("");
    setImageFailed(false);
    (async () => {
      const blob = await attachmentBlob(meeting, file);
      if (!alive) return;
      if (kind === "image" || kind === "pdf") {
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ kind, url: objectUrl });
        return;
      }
      const decoded = decodePreviewText(new Uint8Array(await blob.arrayBuffer()));
      if (!alive) return;
      if (kind === "csv") {
        const parsed = parseCsv(decoded.text);
        setLoaded({ kind, rows: parsed.rows, truncated: parsed.truncated || decoded.truncated });
      } else setLoaded({ kind: "text", ...decoded });
    })().catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : "資料を読み込めませんでした。");
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [meeting.id, file.id]);
  const downloadHint = (
    <button type="button" className="button secondary small" onClick={onDownload}>
      <Download size={14} />
      ダウンロード
    </button>
  );
  return (
    <Modal title={file.name} subtitle="添付資料をアプリ内で表示しています。" onClose={onClose} className="attachment-viewer-modal">
      <div className="attachment-viewer">
        {error ? (
          <div className="attachment-viewer-message" role="alert">
            <p>{error}</p>
            {downloadHint}
          </div>
        ) : !loaded ? (
          <div className="attachment-viewer-message" role="status">
            <LoaderCircle size={20} className="spin" />
            <p>資料を読み込んでいます…</p>
          </div>
        ) : loaded.kind === "image" ? (
          imageFailed ? (
            <div className="attachment-viewer-message" role="alert">
              <p>
                このブラウザーではこの画像形式を表示できません（HEICはSafariで表示できます）。ダウンロードして開いてください。
              </p>
              {downloadHint}
            </div>
          ) : (
            <img
              className="attachment-viewer-image"
              src={loaded.url}
              alt={file.name}
              onError={() => setImageFailed(true)}
            />
          )
        ) : loaded.kind === "pdf" ? (
          <Suspense
            fallback={
              <div className="attachment-viewer-message" role="status">
                <LoaderCircle size={20} className="spin" />
                <p>PDFを準備しています…</p>
              </div>
            }
          >
            <PdfPreview
              url={loaded.url}
              label={file.name}
              errorHint="ダウンロードして開いてください。"
            />
          </Suspense>
        ) : loaded.kind === "csv" ? (
          <>
            <div className="attachment-viewer-table">
              <table>
                <tbody>
                  {loaded.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) =>
                        i === 0 ? <th key={j}>{cell}</th> : <td key={j}>{cell}</td>,
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {loaded.truncated && (
              <p className="attachment-viewer-note">
                先頭の一部だけを表示しています。すべての行はダウンロードして確認してください。
              </p>
            )}
          </>
        ) : loaded.kind === "text" ? (
          <>
            <pre className="attachment-viewer-text">{loaded.text}</pre>
            {loaded.truncated && (
              <p className="attachment-viewer-note">
                先頭の一部だけを表示しています。全文はダウンロードして確認してください。
              </p>
            )}
          </>
        ) : null}
      </div>
      <div className="modal-footer">
        <span>AIには送信していません。</span>
        {downloadHint}
      </div>
    </Modal>
  );
}
