import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;
export function PdfPreview({ url }: { url: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(900);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = new ResizeObserver((entries) =>
      setWidth(
        Math.max(150, Math.min(1000, entries[0].contentRect.width - 24)),
      ),
    );
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    setPdf(null);
    setPage(1);
    setError("");
    setLoading(true);
    const task = getDocument({
      url,
      withCredentials: false,
      cMapUrl: `${import.meta.env.BASE_URL}pdf-assets/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${import.meta.env.BASE_URL}pdf-assets/standard_fonts/`,
      wasmUrl: `${import.meta.env.BASE_URL}pdf-assets/wasm/`,
    });
    task.promise
      .then((value) => {
        if (alive) setPdf(value);
      })
      .catch(() => {
        if (alive) {
          setError(
            "PDFを表示できませんでした。ブラウザーでページを再読み込みしてください。解決しない場合は公開元にお問い合わせください。",
          );
          setLoading(false);
        }
      });
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let alive = true;
    let render: RenderTask | undefined;
    const element = canvas.current;
    setLoading(true);
    setError("");
    (async () => {
      const value = await pdf.getPage(page);
      if (!alive) return;
      const native = value.getViewport({ scale: 1 });
      const scale = Math.min(
        width / native.width,
        2400 / native.height,
        1200 / native.width,
      );
      const viewport = value.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.floor(viewport.width * ratio);
      element.height = Math.floor(viewport.height * ratio);
      element.style.width = `${Math.floor(viewport.width)}px`;
      element.style.height = `${Math.floor(viewport.height)}px`;
      render = value.render({
        canvas: element,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await render.promise;
      if (alive) {
        setLoading(false);
      }
    })().catch((e) => {
      if (alive && e?.name !== "RenderingCancelledException") {
        setError(
          "このページを表示できませんでした。ブラウザーでページを再読み込みしてください。解決しない場合は公開元にお問い合わせください。",
        );
        setLoading(false);
      }
    });
    return () => {
      alive = false;
      render?.cancel();
    };
  }, [pdf, page, width]);
  return (
    <section aria-label="公開PDF" className="pdf-preview">
      {pdf && pdf.numPages > 1 && (
        <div className="pdf-pagination">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            前のページ
          </button>
          <span aria-live="polite">
            {page} / {pdf.numPages} ページ
          </span>
          <button
            disabled={page >= pdf.numPages}
            onClick={() => setPage((p) => p + 1)}
          >
            次のページ
          </button>
        </div>
      )}
      {loading && !error && <p role="status">PDFを表示しています…</p>}
      {error && <p role="alert">{error}</p>}
      <div ref={container} className="pdf-canvas-container">
        <canvas
          ref={canvas}
          aria-label={`公開PDF ${page}ページ`}
          role="img"
          hidden={!pdf || !!error}
        />
      </div>
    </section>
  );
}
