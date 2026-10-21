// Isolated UI preview: synthetic aggregates only, no login, DB or scan requests.
import { createServer } from "vite";
const entry = "virtual:qr-analytics-preview";
const api = "virtual:qr-analytics-preview-api";
const fixturePath = "/tests/fixtures/qr-analytics.mjs";
const server = await createServer({
  server: { host: "127.0.0.1", port: 5196, strictPort: true },
  plugins: [
    {
      name: "qr-analytics-preview",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === entry || source === api) return "\0" + source;
        if (source === "./qr-api" && importer?.endsWith("/src/QrAnalytics.tsx"))
          return "\0" + api;
      },
      load(id) {
        if (id === "\0" + api)
          return `
        import { qrAnalyticsFixture } from '${fixturePath}';
        const scenario = new URLSearchParams(location.search).get('fixture') || 'mixed';
        const request = async path => {
          const query = new URL(path, location.origin).searchParams;
          return qrAnalyticsFixture(scenario, Number(query.get('days') || 30), query.get('source') || 'all');
        };
        export const useQrApi = () => request;
      `;
        if (id === "\0" + entry)
          return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { QrAnalytics } from '/src/QrAnalytics.tsx';
        import '/src/styles.css';
        import '/src/qr.css';
        createRoot(document.getElementById('root')).render(React.createElement('main', {className:'qr-page', style:{padding:'16px',margin:'auto'}},
          React.createElement('h1', {style:{fontSize:'18px'}}, 'QR分析の表示確認（架空データ）'),
          React.createElement('nav', {'aria-label':'検証データ',style:{display:'flex',gap:'12px',flexWrap:'wrap'}},
            ...[['mixed','混在'],['legacy','旧履歴のみ'],['identified','ID取得済み'],['empty','アクセスなし'],['bot','ボットのみ']].map(([value,label]) => React.createElement('a',{key:value,href:'?fixture='+value},label))),
          React.createElement(QrAnalytics,{linkId:'00000000-0000-4000-8000-000000000099',refreshKey:0})
        ));
      `;
      },
      configureServer(vite) {
        vite.middlewares.use(
          "/__qr_analytics_preview",
          async (req, res, next) => {
            if (req.url.split("?")[0] !== "/") return next();
            const html = await vite.transformIndexHtml(
              "/__qr_analytics_preview",
              '<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR分析・架空データ検証</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:qr-analytics-preview"></script></body></html>',
            );
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(html);
          },
        );
      },
    },
  ],
});
await server.listen();
console.log(
  "Synthetic-only preview: http://127.0.0.1:5196/__qr_analytics_preview",
);
