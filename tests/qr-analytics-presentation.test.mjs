import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import {
  browserReferenceCount,
  formatBrowserReference,
} from "../src/qr-analytics-presentation.mjs";
import { chartGeometry } from "../src/qr-chart.mjs";
import * as labels from "../src/qr-labels.mjs";
import { qrAnalyticsFixture } from "./fixtures/qr-analytics.mjs";

function renderAnalytics(scenario = "mixed", options = {}) {
  const data = options.data ?? qrAnalyticsFixture(scenario);
  const values = [
    30,
    "all",
    options.view ?? "chart",
    options.metric ?? "accesses",
    options.reference ?? false,
    data,
    options.error ?? "",
    false,
    0,
    options.highlight ?? null,
  ];
  let cursor = 0;
  const module = { exports: {} };
  const imports = {
    "react/jsx-runtime": jsx,
    react: {
      useState(initial) {
        const i = cursor++;
        return [
          values[i] ?? initial,
          (value) => {
            values[i] = value;
          },
        ];
      },
      useEffect() {},
      useRef: () => ({ current: 0 }),
    },
    "lucide-react": { RefreshCw: () => null, TrendingUp: () => null },
    "./qr-api": {
      useQrApi: () => async () => {
        throw new Error("No API calls during render test");
      },
    },
    "./qr-chart.mjs": { chartGeometry },
    "./qr-labels.mjs": labels,
    "./qr-analytics-presentation.mjs": {
      browserReferenceCount,
      formatBrowserReference,
    },
  };
  const code = ts.transpileModule(
    readFileSync(new URL("../src/QrAnalytics.tsx", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require(name) {
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    },
  });
  const tree = module.exports.QrAnalytics({
    linkId: data.linkId,
    refreshKey: 0,
  });
  return { tree, values, html: renderToStaticMarkup(tree) };
}

test("Reference counts distinguish observed IDs, zero accesses and unavailable identity", () => {
  assert.equal(formatBrowserReference(1, 2), "1件");
  assert.equal(formatBrowserReference(2, 2), "2件"); // separate storage cannot prove one device
  assert.equal(formatBrowserReference(0, 0), "0件");
  assert.equal(formatBrowserReference(0, 4), "未計測・対象外");
  assert.equal(browserReferenceCount(0, 4), null);
});

test("Missing reference days create gaps, never invented zeros or connecting lines", () => {
  const chart = chartGeometry(
    [0, 1, null, 2, 0].map((count, i) => ({ date: `day-${i}`, count })),
  );
  assert.equal(chart.points[2].y, null);
  assert.equal(chart.polylines.length, 2);
  assert.equal(chart.polyline, "");
  assert.equal(chart.points[0].y, chart.height - chart.bottom);
  assert.ok(chart.polylines.every((line) => !/NaN|null|undefined/.test(line)));
  const missing = chartGeometry([{ date: "day", count: null }]);
  assert.deepEqual(missing.polylines, []);
});

test("Primary view emphasizes three access KPIs, with reference values closed by default", () => {
  const { html } = renderAnalytics();
  const primary = html.match(
    /<div class="qr-analysis-kpis">(.*?)<\/div><\/div>/s,
  )?.[1];
  assert.match(primary, /累計・延べアクセス/);
  assert.match(primary, /直近30日・延べアクセス/);
  assert.match(primary, /今日・延べアクセス/);
  assert.doesNotMatch(primary, /ブラウザー参考値/);
  assert.match(html, /<details class="qr-browser-reference">/);
  assert.match(html, /人数・端末数は計測していません/);
  assert.match(html, /同じスマホでも、コードスキャナー/);
  assert.doesNotMatch(html, /グラフの集計指標|qr-breakdown-reference/);
  assert.doesNotMatch(html, /ユニーク/);
});

test("Legacy-only references show unavailable in KPIs, breakdown and daily tables", () => {
  const { html } = renderAnalytics("legacy", {
    reference: true,
    view: "table",
  });
  assert.match(html, /<details class="qr-browser-reference" open="">/);
  assert.match(html, /qr-reference-unavailable/);
  assert.match(
    html,
    /2026-10-06<\/th><td>4回<\/td><td>未計測・対象外<\/td><td>4回/,
  );
  assert.match(html, /期間合計<\/th><td>4回<\/td><td>未計測・対象外/);
  assert.match(html, /QRコード<\/th><td>4回<\/td><td>未計測・対象外/);
  assert.match(html, /2026-10-07<\/th><td>0回<\/td><td>0件/);
});

test("Reference chart omits unknown-day points, and readout announces unmeasured", () => {
  const { html } = renderAnalytics("legacy", {
    reference: true,
    metric: "unique",
    highlight: "2026-10-06",
  });
  assert.doesNotMatch(html, /aria-label="2026-10-06：0件"/);
  assert.match(html, /2026-10-07：0件/);
  assert.match(html, /ブラウザー参考値 未計測・対象外/);
  assert.match(html, /未計測・対象外の日は点と線を表示せず/);
});

test("Known IDs, bots and empty periods retain their real counts without inventing people", () => {
  const identified = renderAnalytics("identified", {
    reference: true,
    view: "table",
  }).html;
  assert.match(identified, /2026-10-07<\/th><td>2回<\/td><td>1件/);
  const bots = renderAnalytics("bot", { reference: true, view: "table" }).html;
  assert.match(
    bots,
    /2026-10-07<\/th><td>2回<\/td><td>未計測・対象外<\/td><td>0回<\/td><td>2回/,
  );
  const empty = renderAnalytics("empty", { reference: true }).html;
  assert.doesNotMatch(empty, /class="qr-reference-unavailable"/);
  assert.match(empty, /この期間のアクセスはまだありません/);
});

function nodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
test("Closing reference details resets the graph to the primary access metric", () => {
  const { tree, values } = renderAnalytics("mixed", {
    reference: true,
    metric: "unique",
  });
  const details = nodes(tree).find((n) => n.type === "details");
  details.props.onToggle({ currentTarget: { open: false } });
  assert.equal(values[4], false);
  assert.equal(values[3], "accesses");
});

test("Failed refresh retains prior results and never silently renders zero", () => {
  const { html } = renderAnalytics("mixed", {
    error: "通信を確認してください。",
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /前回の集計を表示しています/);
  assert.match(html, /6<small>回/);
});
