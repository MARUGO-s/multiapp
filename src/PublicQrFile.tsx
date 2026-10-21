import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PdfPreview } from "./PdfPreview";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./cloud";
import "./qr-file-viewer.css";
type PublicFile = {
  mime: string;
  url: string;
};
function PublicQrFile() {
  const code = new URLSearchParams(location.search).get("file") ?? "";
  const [file, setFile] = useState<PublicFile | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [html, setHtml] = useState("");
  useEffect(() => {
    document.title = "公開ファイル — MARUGO QR";
    let alive = true;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setFile(null);
    (async () => {
      if (!/^[A-Za-z0-9_-]{12}$/.test(code))
        throw new Error("ファイルのURLが正しくありません。");
      const response = await fetch(
        `${SUPABASE_URL}/functions/v1/marugo-qr/files/${code}`,
        {
          headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "ファイルを開けませんでした。");
      if (alive) {
        setFile(data);
      }
    })()
      .catch((e) => {
        if (alive)
          setError(
            e instanceof Error ? e.message : "ファイルを開けませんでした。",
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      abort.abort();
    };
  }, [code, reload]);
  useEffect(() => {
    if (file?.mime !== "text/html") return;
    let alive = true;
    const abort = new AbortController();
    setHtml("");
    fetch(file.url, {
      signal: abort.signal,
      cache: "no-store",
      referrerPolicy: "no-referrer",
    })
      .then((response) => {
        if (!response.ok) throw new Error("HTMLを表示できませんでした。");
        return response.text();
      })
      .then((text) => {
        if (alive) setHtml(text);
      })
      .catch((error) => {
        if (alive && error?.name !== "AbortError")
          setError("HTMLを表示できませんでした。ページを再読み込みしてください。");
      });
    return () => {
      alive = false;
      abort.abort();
    };
  }, [file]);
  return (
    <main className="public-qr-file" aria-label="公開ファイル">
      <header>
        <small>MARUGO QR</small>
      </header>
      {loading && <p role="status">ファイルを準備しています…</p>}
      {error && (
        <section role="alert">
          <p>{error}</p>
          <button onClick={() => setReload((n) => n + 1)}>もう一度試す</button>
        </section>
      )}
      {file && (
        file.mime === "application/pdf" ? (
          <PdfPreview key={file.url} url={file.url} />
        ) : file.mime === "text/html" && html ? (
          <iframe
            title="公開HTML"
            srcDoc={html}
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
          />
        ) : file.mime === "text/html" ? (
          <p role="status">HTMLを準備しています…</p>
        ) : (
          <img src={file.url} alt="公開画像" referrerPolicy="no-referrer" />
        )
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<PublicQrFile />);
