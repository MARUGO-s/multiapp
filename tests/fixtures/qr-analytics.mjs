// Synthetic presentation fixtures only. Never send these to the production API.
export function qrAnalyticsFixture(
  scenario = "mixed",
  days = 30,
  source = "all",
) {
  const end = new Date("2026-10-07T00:00:00Z");
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - days + index + 1);
    return {
      date: date.toISOString().slice(0, 10),
      count: 0,
      uniqueCount: 0,
      unknownCount: 0,
      botCount: 0,
    };
  });
  const yesterday = daily.at(-2);
  const today = daily.at(-1);
  if (scenario === "legacy" || scenario === "mixed") {
    Object.assign(yesterday, { count: 4, unknownCount: 4 });
  }
  if (scenario === "identified" || scenario === "mixed") {
    // Same observed ID, two accesses: one reference ID, not two people.
    Object.assign(today, { count: 2, uniqueCount: 1 });
  }
  if (scenario === "bot") Object.assign(today, { count: 2, botCount: 2 });
  const periodTotal = daily.reduce((sum, day) => sum + day.count, 0);
  const unknownAccesses = daily.reduce((sum, day) => sum + day.unknownCount, 0);
  const botAccesses = daily.reduce((sum, day) => sum + day.botCount, 0);
  const periodUnique = today.uniqueCount;
  const rows = (key) =>
    periodTotal ? [{ key, count: periodTotal, uniqueCount: periodUnique }] : [];
  return {
    linkId: "00000000-0000-4000-8000-000000000099",
    days,
    source,
    startDate: daily[0].date,
    endDate: today.date,
    daily,
    periodTotal,
    total: periodTotal,
    periodUnique,
    totalUnique: periodUnique,
    identifiedAccesses: periodTotal - unknownAccesses - botAccesses,
    unknownAccesses,
    botAccesses,
    generatedAt: "2026-10-07T12:20:00Z",
    sources: rows(source === "all" ? "qr" : source),
    devices: rows(scenario === "bot" ? "bot" : "mobile"),
    browsers: rows("safari"),
    referrers: rows("unknown"),
  };
}
