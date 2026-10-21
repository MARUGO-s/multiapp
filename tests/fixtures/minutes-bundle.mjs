// Intentionally different narrative lengths; not an AI quality evaluation.
export function minutesBundle(base) {
  return {
    decisions: base.decisions,
    actions: base.actions,
    openQuestions: base.openQuestions,
    scheduleEvents: base.scheduleEvents || [],
    formats: {
      brief: { summary: `要約：${base.summary}`, topics: base.topics.slice(0, 1).map(t => ({ ...t, points: t.points.slice(0, 1) })) },
      standard: { summary: `標準：${base.summary}`, topics: base.topics.slice(0, 2) },
      detailed: { summary: `詳細：${base.summary}`, topics: base.topics },
    },
  };
}
