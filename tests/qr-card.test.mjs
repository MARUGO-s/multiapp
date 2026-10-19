import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardDestination,
  cardHtml,
  shareCardUrl,
} from "../supabase/functions/_shared/qr-card.mjs";

test("LINE card uses the file name and not the workspace description", () => {
  const html = cardHtml(
    '高知食材_販売レポート.html"><script>',
    cardDestination("aP308X3p5yyc", "b"),
  );
  assert.match(html, /<title>高知食材_販売レポート\.html&quot;&gt;&lt;script&gt;<\/title>/);
  assert.match(html, /property="og:title" content="高知食材_販売レポート\.html/);
  assert.doesNotMatch(html, /会議録|アプリ選択|kotonoha|アクセス分析/);
  assert.match(html, /https:\/\/marugo-waltz\.com\/\?s=b#aP308X3p5yyc/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

test("copied share URL keeps the code where a crawler can read it", () => {
  assert.equal(
    shareCardUrl("https://example.supabase.co", "aP308X3p5yyc", "button"),
    "https://example.supabase.co/functions/v1/marugo-qr/card/aP308X3p5yyc?s=b",
  );
});
