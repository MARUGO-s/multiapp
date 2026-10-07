import { useEffect, useRef, useState } from "react";
import { RefreshCw, TrendingUp } from "lucide-react";
import { useQrApi, type QrAnalyticsData } from "./qr-api";
import { chartGeometry } from "./qr-chart.mjs";
import { sourceLabels, deviceLabels, browserLabels } from "./qr-labels.mjs";

function Breakdown({
  title,
  entries,
  labels,
  total,
  view,
}: {
  title: string;
  entries: { key: string; count: number; uniqueCount: number }[];
  labels: Record<string, string>;
  total: number;
  view: "chart" | "table";
}) {
  return (
    <section className="qr-breakdown">
      <h3>{title}</h3>
      {!entries.length ? (
        <p>この期間のアクセスはありません。</p>
      ) : view === "chart" ? (
        <ul>
          {entries.map((entry) => (
            <li key={entry.key}>
              <div>
                <span>{labels[entry.key] ?? entry.key}</span>
                <strong>
                  {entry.count.toLocaleString()}回{" "}
                  <small>
                    （{total ? ((entry.count / total) * 100).toFixed(1) : "0.0"}
                    %）
                  </small>
                  <small>
                    {" "}
                    ／ ユニーク {entry.uniqueCount.toLocaleString()}件
                  </small>
                </strong>
              </div>
              <div className="qr-bar-track" aria-hidden="true">
                <span
                  style={{
                    width: `${total ? (entry.count / total) * 100 : 0}%`,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div
          className="qr-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={`${title}の表`}
        >
          <table className="qr-data-table">
            <caption>{title}（選択期間）</caption>
            <thead>
              <tr>
                <th scope="col">分類</th>
                <th scope="col">回数</th>
                <th scope="col">ユニーク</th>
                <th scope="col">割合</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.key}>
                  <th scope="row">{labels[entry.key] ?? entry.key}</th>
                  <td>{entry.count.toLocaleString()}回</td>
                  <td>{entry.uniqueCount.toLocaleString()}件</td>
                  <td>
                    {total ? ((entry.count / total) * 100).toFixed(1) : "0.0"}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const shortDate = (date: string) => date.slice(5).replace("-", "/");
export function QrAnalytics({
  linkId,
  refreshKey,
}: {
  linkId: string;
  refreshKey: number;
}) {
  const qrApi = useQrApi();
  const [days, setDays] = useState(30);
  const [source, setSource] = useState("all");
  const [view, setView] = useState<"chart" | "table">("chart");
  const [metric, setMetric] = useState<"accesses" | "unique">("accesses");
  const [data, setData] = useState<QrAnalyticsData | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [manual, setManual] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const requestNumber = useRef(0);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    setData((previous) =>
      previous?.linkId === linkId &&
      previous.days === days &&
      previous.source === source
        ? previous
        : null,
    );
    setHighlight(null);
    setError("");
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const request = ++requestNumber.current;
      setPending(true);
      try {
        const next = await qrApi<QrAnalyticsData>(
          `/links/${linkId}/analytics?days=${days}&source=${source}`,
        );
        if (!alive || request !== requestNumber.current) return;
        setData(next);
        setError("");
      } catch (e) {
        if (alive && request === requestNumber.current) {
          setError(
            e instanceof Error
              ? e.message
              : "アクセス集計を更新できませんでした。",
          );
        }
      } finally {
        inFlight = false;
        if (alive && request === requestNumber.current) setPending(false);
      }
    };
    void load();
    const interval = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    const visible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [linkId, days, source, refreshKey, manual]);
  // Never render the previous QR/period's result during a selection change.
  const current =
    data?.linkId === linkId && data.days === days && data.source === source
      ? data
      : null;
  const chart = chartGeometry(
    (current?.daily ?? []).map((day) => ({
      date: day.date,
      count: metric === "unique" ? day.uniqueCount : day.count,
    })),
  );
  const metricLabel = metric === "unique" ? "ユニーク数" : "延べアクセス数";
  const unit = metric === "unique" ? "件" : "回";
  const active =
    current?.daily.find((day) => day.date === highlight) ??
    current?.daily.at(-1);
  const today = current?.daily.at(-1)?.count ?? 0;
  const todayUnique = current?.daily.at(-1)?.uniqueCount ?? 0;
  return (
    <section className="qr-analytics" aria-label="アクセス分析">
      <div className="qr-analytics-heading">
        <div>
          <h2>
            <TrendingUp size={23} />
            アクセス分析
          </h2>
          <p>
            延べアクセス数と、ブラウザー単位のユニーク数。日本時間で集計します。
          </p>
        </div>
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => setManual((n) => n + 1)}
        >
          <RefreshCw size={16} className={pending ? "spin" : ""} />
          分析を更新
        </button>
      </div>
      <div className="qr-analysis-controls">
        <div className="qr-segmented" role="group" aria-label="集計期間">
          {[7, 30, 90].map((value) => (
            <button
              key={value}
              aria-pressed={days === value}
              onClick={() => setDays(value)}
            >
              {value}日
            </button>
          ))}
        </div>
        <label className="qr-source-filter">
          流入経路
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {Object.entries(sourceLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="qr-segmented" role="group" aria-label="分析の表示形式">
          <button
            aria-pressed={view === "chart"}
            onClick={() => setView("chart")}
          >
            グラフ
          </button>
          <button
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            表
          </button>
        </div>
        {view === "chart" && (
          <div
            className="qr-segmented"
            role="group"
            aria-label="グラフの集計指標"
          >
            <button
              aria-pressed={metric === "accesses"}
              onClick={() => setMetric("accesses")}
            >
              延べアクセス
            </button>
            <button
              aria-pressed={metric === "unique"}
              onClick={() => setMetric("unique")}
            >
              ユニーク
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
          {current && " 前回の集計を表示しています。"}
        </p>
      )}
      {!current ? (
        <p role="status">
          {error
            ? "集計を取得できませんでした。「分析を更新」で再試行できます。"
            : "アクセス数を集計しています…"}
        </p>
      ) : (
        <>
          <div className="qr-analysis-kpis">
            <div>
              <span>
                累計・延べアクセス{source !== "all" && "（選択経路）"}
              </span>
              <strong>
                {current.total.toLocaleString()}
                <small>回</small>
              </strong>
            </div>
            <div>
              <span>直近{days}日・延べアクセス</span>
              <strong>
                {current.periodTotal.toLocaleString()}
                <small>回</small>
              </strong>
            </div>
            <div>
              <span>今日・延べアクセス</span>
              <strong>
                {today.toLocaleString()}
                <small>回</small>
              </strong>
            </div>
            <div>
              <span>累計・ユニーク{source !== "all" && "（選択経路）"}</span>
              <strong>
                {current.totalUnique.toLocaleString()}
                <small>件</small>
              </strong>
            </div>
            <div>
              <span>直近{days}日・ユニーク</span>
              <strong>
                {current.periodUnique.toLocaleString()}
                <small>件</small>
              </strong>
            </div>
            <div>
              <span>今日・ユニーク</span>
              <strong>
                {todayUnique.toLocaleString()}
                <small>件</small>
              </strong>
            </div>
          </div>
          <p className="qr-unique-note">
            ユニークは、このQR内で同じブラウザーを期間内に1件として数えた目安で、人数ではありません。
            対応後に匿名IDを取得できたアクセスのみが対象です。別端末・別ブラウザー・シークレットモード・保存データの削除・IDの180日期限後は別件になります。
            日別や内訳のユニーク数には重複があるため、足しても期間全体のユニーク数にはなりません。
            <br />
            選択期間：ID取得済み {current.identifiedAccesses.toLocaleString()}回
            ／ 判別不能（旧履歴・保存不可など）
            {current.unknownAccesses.toLocaleString()}回 ／ 推定ボット{" "}
            {current.botAccesses.toLocaleString()}回。
            判別不能・推定ボットは延べアクセスに含み、ユニークには含めません。ボット判定は完全ではありません。
          </p>
          <p className="qr-analysis-meta">
            {current.startDate} 〜 {current.endDate} ・経路：
            {sourceLabels[source]} ・表示中は約10秒ごとに自動更新
            <br />
            最終取得：
            {new Intl.DateTimeFormat("ja-JP", {
              timeZone: "Asia/Tokyo",
              dateStyle: "short",
              timeStyle: "medium",
            }).format(new Date(current.generatedAt))}
          </p>
          {view === "chart" ? (
            <>
              <div className="qr-chart-scroll">
                <svg
                  viewBox={`0 0 ${chart.width} ${chart.height}`}
                  className="qr-trend-chart"
                  role="group"
                  aria-label={`直近${days}日の${metricLabel}推移。期間全体${metric === "unique" ? current.periodUnique : current.periodTotal}${unit}。各点を選ぶと日別の値を確認できます。`}
                >
                  {chart.ticks.map((tick) => (
                    <g key={tick.value} aria-hidden="true">
                      <line
                        x1={chart.left}
                        x2={chart.width - chart.right}
                        y1={tick.y}
                        y2={tick.y}
                        className="qr-chart-grid"
                      />
                      <text x={chart.left - 10} y={tick.y + 5} textAnchor="end">
                        {tick.value.toLocaleString()}
                      </text>
                    </g>
                  ))}
                  <text x={chart.left} y={15} aria-hidden="true">
                    {metricLabel}（{unit}）
                  </text>
                  <polyline
                    points={chart.polyline}
                    className="qr-chart-line"
                    aria-hidden="true"
                  />
                  {chart.points.map((point) => (
                    <circle
                      key={point.date}
                      cx={point.x}
                      cy={point.y}
                      r={active?.date === point.date ? 6 : 4}
                      className="qr-chart-point"
                      tabIndex={0}
                      role="button"
                      aria-label={`${point.date}：${point.count}${unit}`}
                      onMouseEnter={() => setHighlight(point.date)}
                      onFocus={() => setHighlight(point.date)}
                      onClick={() => setHighlight(point.date)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setHighlight(point.date);
                        }
                      }}
                    >
                      <title>
                        {point.date}：{point.count.toLocaleString()}
                        {unit}
                      </title>
                    </circle>
                  ))}
                  {chart.labelIndexes.map((index) => (
                    <text
                      key={index}
                      x={chart.points[index]?.x}
                      y={chart.height - 12}
                      textAnchor="middle"
                      aria-hidden="true"
                    >
                      {shortDate(current.daily[index].date)}
                    </text>
                  ))}
                </svg>
              </div>
              <p className="qr-chart-readout" role="status">
                {active?.date}：{metricLabel}{" "}
                {(
                  (metric === "unique" ? active?.uniqueCount : active?.count) ??
                  0
                ).toLocaleString()}
                {unit}
                <span>点に触れるか選択すると、日別の値を確認できます。</span>
              </p>
              {current.periodTotal === 0 && (
                <p className="qr-analysis-meta">
                  この期間のアクセスはまだありません。0回の日も表示しています。
                </p>
              )}
            </>
          ) : (
            <div
              className="qr-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="日別アクセス数の表"
            >
              <table className="qr-data-table">
                <caption>日別アクセス数（日本時間）</caption>
                <thead>
                  <tr>
                    <th scope="col">日付</th>
                    <th scope="col">アクセス数</th>
                    <th scope="col">ユニーク</th>
                    <th scope="col">判別不能</th>
                    <th scope="col">推定ボット</th>
                  </tr>
                </thead>
                <tbody>
                  {[...current.daily].reverse().map((day) => (
                    <tr key={day.date}>
                      <th scope="row">{day.date}</th>
                      <td>{day.count.toLocaleString()}回</td>
                      <td>{day.uniqueCount.toLocaleString()}件</td>
                      <td>{day.unknownCount.toLocaleString()}回</td>
                      <td>{day.botCount.toLocaleString()}回</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">期間合計</th>
                    <td>{current.periodTotal.toLocaleString()}回</td>
                    <td>{current.periodUnique.toLocaleString()}件</td>
                    <td>{current.unknownAccesses.toLocaleString()}回</td>
                    <td>{current.botAccesses.toLocaleString()}回</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <div className="qr-breakdown-grid">
            <Breakdown
              title="流入経路別"
              entries={current.sources}
              labels={sourceLabels}
              total={current.periodTotal}
              view={view}
            />
            <Breakdown
              title="端末別（推定）"
              entries={current.devices}
              labels={deviceLabels}
              total={current.periodTotal}
              view={view}
            />
            <Breakdown
              title="ブラウザー別（推定）"
              entries={current.browsers}
              labels={browserLabels}
              total={current.periodTotal}
              view={view}
            />
            <Breakdown
              title="流入元サイト別"
              entries={current.referrers}
              labels={{
                unknown: "不明／直接アクセス",
                other_hosts: "その他（11位以降）",
              }}
              total={current.periodTotal}
              view={view}
            />
          </div>
          <p className="qr-analysis-meta">
            流入元はドメインのみ保存します。アプリ内ブラウザーやプライバシー設定によって取得できない場合があります。過去のアクセスには経路情報がないため「不明・旧URL」として表示します。
          </p>
        </>
      )}
    </section>
  );
}
