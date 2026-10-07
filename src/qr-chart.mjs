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
