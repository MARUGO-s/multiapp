import assert from "node:assert/strict";
import { test } from "node:test";
import { hourlyGeometry } from "../src/qr-chart.mjs";

const hours = (counts) => counts.map((count, hour) => ({ hour, count }));

test("hour-of-day chart always draws 24 bars from 0 to 23 with a zero baseline", () => {
  const counts = Array(24).fill(0);
  counts[9] = 7;
  counts[21] = 3;
  const chart = hourlyGeometry(hours(counts));
  assert.equal(chart.bars.length, 24);
  assert.deepEqual(chart.bars.map((b) => b.hour), [...Array(24).keys()]);
  const base = chart.height - chart.bottom;
  assert.equal(chart.bars[0].y + chart.bars[0].height, base);
  assert.equal(chart.bars[0].height, 0);
  assert.ok(chart.bars[9].height > chart.bars[21].height);
  assert.equal(chart.bars[9].y + chart.bars[9].height, base);
  assert.ok(chart.bars.every((b, i) => i === 0 || b.x > chart.bars[i - 1].x));
  assert.ok(chart.ticks.every((t) => Number.isInteger(t.value)));
  assert.equal(chart.ticks[0].value, 0);
  assert.ok(chart.ticks.at(-1).value >= 7);
  assert.equal(chart.peakHour, 9);
});

test("hour-of-day chart is safe for empty, missing and unavailable values", () => {
  const empty = hourlyGeometry([]);
  assert.equal(empty.bars.length, 24);
  assert.ok(empty.bars.every((b) => b.count === 0 && b.height === 0));
  assert.equal(empty.peakHour, null);
  const partial = hourlyGeometry([{ hour: 5, count: 2 }, { hour: 30, count: 9 }]);
  assert.equal(partial.bars[5].count, 2);
  assert.equal(partial.bars.reduce((s, b) => s + (b.count ?? 0), 0), 2);
  const unavailable = hourlyGeometry([{ hour: 3, count: null }]);
  assert.equal(unavailable.bars[3].count, null);
  assert.equal(unavailable.bars[3].height, 0);
  assert.ok(unavailable.bars.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)));
});
