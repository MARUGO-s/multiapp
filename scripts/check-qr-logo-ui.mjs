// Synthetic-only UI harness: actual React components, fake API boundary.
// This never reads credentials, sends email, logs a scan or writes a real QR.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const root =
  process.env.QR_PREVIEW_ROOT || fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.QR_PREVIEW_PORT || 5197);
const entry = "virtual:qr-logo-preview";
const api = "virtual:qr-logo-preview-api";
const cloud = "virtual:qr-logo-preview-cloud";
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port, strictPort: true },
  plugins: [
    {
      name: "qr-logo-preview",
      enforce: "pre",
      resolveId(source, importer) {
        if ([entry, api, cloud].includes(source)) return "\0" + source;
        if (importer?.includes("/src/") && source === "./qr-api")
          return "\0" + api;
        if (importer?.includes("/src/") && source === "./cloud")
          return "\0" + cloud;
      },
      load(id) {
        if (id === "\0" + cloud) return "export const isCloud = true;";
        if (id === "\0" + api)
          return `
        import { buildTrackingUrl } from '/src/qr-routing.mjs';
        import { qrAnalyticsFixture } from '/tests/fixtures/qr-analytics.mjs';
        const initial = [{id:'00000000-0000-4000-8000-000000000001',code:'AbCd1234EfGh',title:'店頭ポスター（検証用）',target_url:'https://example.invalid/menu',scan_count:37,active:true,created_at:'2026-10-01T01:00:00Z',last_accessed_at:'2026-10-17T01:00:00Z',deleted_at:null,logo_id:null,store_name:null}];
        const control = window.__qrFixture = {calls:[], notifications:[], rows:structuredClone(initial), failure:null, holdNextList:false, pendingLists:[], nextNumber:2};
        const clone = value => structuredClone(value);
        export const trackingUrl = (code,source='unknown') => buildTrackingUrl('/multiapp/','https://marugo-s.github.io',code,source);
        const request = async (path, options={}) => {
          const method = options.method || 'GET';
          const body = options.body ? JSON.parse(options.body) : null;
          control.calls.push({path,method,body});
          if (control.failure === 'expired' && method !== 'GET') throw new Error('ログインの有効期限が切れました。');
          if (control.failure === 'offline' && method !== 'GET') throw new Error('通信結果を確認できませんでした。');
          if (control.failure === 'list' && path.startsWith('/links?')) throw new Error('一覧を取得できませんでした。');
          if (method === 'GET' && path.startsWith('/links?')) {
            const rows=clone(control.rows.filter(row => !row.deleted_at));
            const result={links:rows,total:rows.length};
            if (control.holdNextList) {
              control.holdNextList=false;
              return await new Promise(resolve => control.pendingLists.push(()=>resolve(result)));
            }
            return result;
          }
          if (method === 'GET' && path.includes('/history')) return {events:[],total:0};
          if (method === 'GET' && path.includes('/analytics')) {
            const query = new URL(path,location.origin).searchParams;
            return qrAnalyticsFixture('mixed',Number(query.get('days')||30),query.get('source')||'all');
          }
          if (method === 'PATCH' && path.endsWith('/logo')) {
            const id=path.split('/')[2];
            const row=control.rows.find(row=>row.id===id);
            if(!row) throw new Error('QRが見つかりません。');
            if (control.failure === 'caption-mismatch') return {...clone(row), logo_id:body.logoId, store_name:'mismatched response'};
            row.logo_id=body.logoId;
            row.store_name=body.storeName ?? null;
            if(control.failure==='unknown-once') { control.failure=null; throw new Error('通信結果を確認できませんでした。'); }
            return clone(row);
          }
          if (method === 'POST' && (path === '/links' || path === '/uploads')) {
            let row=control.rows.find(row=>row.id===body.id);
            if(!row) {
              const n=control.nextNumber++;
              row={...initial[0],id:body.id,code:n===2?'MnOp1234QrSt':'UvWx1234YzAb',title:body.title,target_url:body.targetUrl||'https://example.invalid/published-file',scan_count:0,last_accessed_at:null,logo_id:body.logoId||null,store_name:body.storeName ?? null};
              control.rows.unshift(row);
            }
            if(control.failure==='unknown-once') {control.failure=null; throw new Error('通信結果を確認できませんでした。');}
            return path==='/uploads'?{link:clone(row)}:clone(row);
          }
          if (method==='PATCH' && path.startsWith('/links/')) {
            const row=control.rows.find(row=>row.id===path.split('/')[2]);
            Object.assign(row,{active:body.active}); return clone(row);
          }
          throw new Error('Unexpected synthetic request: '+method+' '+path);
        };
        export const useQrApi = () => request;
      `;
        if (id === "\0" + entry)
          return `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { QrPage } from '/src/QrPage.tsx';
        import '/src/styles.css';
        import '/src/qr.css';
        const notify=message => {window.__qrFixture.notifications.push(message); document.getElementById('notice').textContent=message;};
        createRoot(document.getElementById('root')).render(React.createElement('main',{className:'workspace-content',style:{padding:'24px',margin:0}},
          React.createElement('p',{style:{color:'#68677b',fontSize:'12px'}},'表示・操作検証：架空データのみ／本番への通信なし'),
          React.createElement('p',{id:'notice',role:'status','aria-live':'polite'}),
          React.createElement(QrPage,{notify})
        ));
      `;
      },
      configureServer(vite) {
        vite.middlewares.use("/__qr_logo_preview", async (req, res, next) => {
          if (req.url.split("?")[0] !== "/") return next();
          const html = await vite.transformIndexHtml(
            "/__qr_logo_preview",
            '<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MARUGO QR ロゴ機能・架空データ検証</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:qr-logo-preview"></script></body></html>',
          );
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
        });
      },
    },
  ],
});
await server.listen();
console.log(
  `Synthetic-only QR preview: http://127.0.0.1:${port}/__qr_logo_preview (root: ${root})`,
);
