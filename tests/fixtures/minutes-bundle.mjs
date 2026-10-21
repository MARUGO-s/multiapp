// Intentionally different narrative lengths; not an AI quality evaluation.
export function minutesBundle(base) {
  const topics = (list) => list.map((t) => ({ ...t, status: t.status || "報告", notes: t.notes || [] }));
  return {
    recordScope: base.recordScope || "会議全体",
    decisionItems: base.decisions.map((decision, i) => ({
      decision,
      note: base.decisionNotes?.[i] || "",
    })),
    actions: base.actions,
    openQuestions: base.openQuestions,
    recordNotes: base.recordNotes || [],
    scheduleEvents: base.scheduleEvents || [],
    formats: {
      brief: { summary: `要約：${base.summary}`, topics: topics(base.topics.slice(0, 1).map(t => ({ ...t, points: t.points.slice(0, 1) }))) },
      standard: { summary: `標準：${base.summary}`, topics: topics(base.topics.slice(0, 2)) },
      detailed: { summary: `詳細：${base.summary}`, topics: topics(base.topics) },
    },
  };
}

// Shape of responses that were already running when the record fields were added.
export function legacyMinutesBundle(base) {
  const { recordScope: _scope, decisionItems, recordNotes: _notes, formats, ...rest } = minutesBundle(base);
  const plain = (format) => ({ ...format, topics: format.topics.map(({ notes: _n, status: _s, ...t }) => t) });
  return {
    ...rest,
    decisions: decisionItems.map((item) => item.decision),
    formats: { brief: plain(formats.brief), standard: plain(formats.standard), detailed: plain(formats.detailed) },
  };
}
