/** @param {Array<{date:string,count:number|null}>} daily */
export function chartGeometry(daily) {
  const width = 760,
    height = 260;
  const left = 54,
    right = 22,
    top = 22,
    bottom = 40;
  const peak = Math.max(0, ...daily.map((day) => day.count ?? 0));
  const step = Math.max(1, Math.ceil(peak / 4));
  const maximum = step * 4;
  const points = daily.map((day, index) => ({
    ...day,
    x: left + (index * (width - left - right)) / Math.max(1, daily.length - 1),
    y:
      day.count === null
        ? null
        : top + (1 - day.count / maximum) * (height - top - bottom),
  }));
  const ticks = Array.from({ length: 5 }, (_, i) => ({
    value: i * step,
    y: top + (1 - i / 4) * (height - top - bottom),
  }));
  const labelIndexes = [
    ...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1]),
  ].filter((i) => i >= 0);
  // Break the line at unavailable values; never invent a zero or bridge a gap.
  const polylines = [];
  let segment = [];
  for (const point of points) {
    if (point.y === null) {
      if (segment.length) polylines.push(segment.join(" "));
      segment = [];
    } else segment.push(`${point.x},${point.y}`);
  }
  if (segment.length) polylines.push(segment.join(" "));
  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    maximum,
    points,
    ticks,
    labelIndexes,
    polylines,
    polyline: polylines.length === 1 ? polylines[0] : "",
  };
}

/**
 * Bars for hours 0-23 (Japan time). Missing hours are zero; a null count
 * (reference value unavailable) draws no bar instead of inventing zero.
 * @param {Array<{hour:number,count:number|null}>} hourly
 */
export function hourlyGeometry(hourly) {
  const width = 760,
    height = 250;
  const left = 54,
    right = 22,
    top = 34,
    bottom = 40;
  const byHour = new Map(
    hourly
      .filter((h) => Number.isInteger(h.hour) && h.hour >= 0 && h.hour <= 23)
      .map((h) => [h.hour, h.count]),
  );
  const values = Array.from({ length: 24 }, (_, hour) =>
    byHour.has(hour) ? (byHour.get(hour) ?? null) : 0,
  );
  const peak = Math.max(0, ...values.map((v) => v ?? 0));
  const step = Math.max(1, Math.ceil(peak / 4));
  const maximum = step * 4;
  const plot = height - top - bottom;
  const slot = (width - left - right) / 24;
  const barWidth = Math.max(4, slot * 0.68);
  const bars = values.map((count, hour) => {
    const barHeight = count === null ? 0 : (count / maximum) * plot;
    return {
      hour,
      count,
      x: left + slot * hour + (slot - barWidth) / 2,
      center: left + slot * hour + slot / 2,
      width: barWidth,
      y: top + plot - barHeight,
      height: barHeight,
    };
  });
  const ticks = Array.from({ length: 5 }, (_, i) => ({
    value: i * step,
    y: top + (1 - i / 4) * plot,
  }));
  let peakHour = null;
  for (const bar of bars)
    if ((bar.count ?? 0) > 0 && (peakHour === null || bar.count > bars[peakHour].count))
      peakHour = bar.hour;
  return { width, height, left, right, top, bottom, maximum, bars, ticks, peakHour };
}
