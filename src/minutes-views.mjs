import { MINUTES_FORMATS, minutesFormat } from "../supabase/functions/_shared/minutes-formats.mjs";

// Pure saved-data selection. No requests, generation or inferred replacement of
// old handwritten minutes is allowed when the user switches tabs.
export function savedMinutesFormats(meeting) {
  return MINUTES_FORMATS.filter((format) =>
    typeof meeting.markdownByFormat?.[format.id] === "string",
  ).map((format) => format.id);
}

export function minutesView(meeting, requested) {
  const available = savedMinutesFormats(meeting);
  const format = available.includes(requested)
    ? requested
    : available.includes(meeting.template)
      ? meeting.template
      : available[0] || minutesFormat(meeting.template).id;
  return {
    format,
    label: minutesFormat(format).label,
    markdown: meeting.markdownByFormat?.[format] ?? meeting.markdown,
    summary: meeting.minutes?.formats?.[format]?.summary ?? meeting.minutes?.summary,
    available,
  };
}
