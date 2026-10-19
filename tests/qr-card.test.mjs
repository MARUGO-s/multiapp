import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardHtml,
  htmlCardPageUrl,
} from "../supabase/functions/_shared/qr-card.mjs";

test("HTML upload cards use that file name and not the workspace description", () => {
  const html = cardHtml('高知食材_販売レポート.html"><script>', "aP308X3p5yyc");
  assert.match(html, /<title>高知食材_販売レポート\.html&quot;&gt;&lt;script&gt;<\/title>/);
  assert.match(html, /property="og:title"/);
  assert.doesNotMatch(html, /会議録|アプリ選択|kotonoha|アクセス分析|http-equiv="refresh"/);
  assert.match(html, /#aP308X3p5yyc/);
});

test("copied HTML share URL keeps the code in the path LINE can fetch", () => {
  assert.equal(
    htmlCardPageUrl("https://marugo-waltz.com", "aP308X3p5yyc", "button"),
    "https://marugo-waltz.com/s/aP308X3p5yyc.html?s=b",
  );
});
