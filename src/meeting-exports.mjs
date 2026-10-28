const escapeICS = (value) =>
  String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
function fold(line) {
  const encoder = new TextEncoder();
  let result = "",
    bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) {
      result += "\r\n ";
      bytes = 1;
    }
    result += char;
    bytes += size;
  }
  return result;
}
export function exportToICS(meetings) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Kotonoha//Meeting Minutes//JA",
    "CALSCALE:GREGORIAN",
  ];
  const stamp =
    new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  for (const m of meetings) {
    // Only the meeting date is known. Do not invent a meeting time.
    const next = new Date(Date.parse(`${m.date}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeICS(m.id)}@kotonoha`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${m.date.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${next.replace(/-/g, "")}`,
      `SUMMARY:${escapeICS(m.title)}`,
      `DESCRIPTION:${escapeICS(`${m.participants}\n\n${m.minutes?.summary || "議事録がありません"}`)}`,
      "END:VEVENT",
    );
  }
  return [...lines, "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";
}
// Export projection only. Preserve calendar event locations and never mutate storage.
export function withoutRecordingLocations(meeting) {
  const { recordingLocations, ...result } = meeting;
  if (result.sources) result.sources = result.sources.map(({ startLocation, ...source }) => source);
  return result;
}
export function exportMultipleMeetings(meetings, format) {
  if (format === "ics") return exportToICS(meetings);
  if (format === "json") return JSON.stringify(meetings.map(withoutRecordingLocations), null, 2);
  return [
    "# 会議録一括エクスポート",
    ...meetings.map(
      (m) =>
        m.markdown ||
        `# ${m.title}\n\n日時：${m.date}\n参加者：${m.participants}\n\n議事録はまだありません。`,
    ),
  ].join("\n\n---\n\n");
}
