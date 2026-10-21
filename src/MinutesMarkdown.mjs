import { createElement as h } from "react";
import { TOPIC_STATUSES } from "../supabase/functions/_shared/minutes-formats.mjs";

// Plain-text cells only: user/AI text must never become HTML or executable links.
export function minutesTableCells(line) {
  if (!line.startsWith("|") || !line.endsWith("|")) return null;
  const cells = [];
  let cell = "";
  for (let i = 1; i < line.length - 1; i++) {
    const char = line[i];
    if (char === "\\" && ["|", "\\"].includes(line[i + 1])) {
      cell += line[++i];
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

const COVER_FIELD = /^(日時|参加者|記録の範囲|次回会議)：(.*)$/;
const TOPIC_STATUS = new RegExp(`^(.*?)\\s*［(${TOPIC_STATUSES.join("|")})］$`);
const statusClass = { 決定: "decided", 提案: "proposed", 継続検討: "pending", 報告: "report" };

function topicHeading(text, key) {
  const match = TOPIC_STATUS.exec(text);
  if (!match) return h("h3", { key }, text);
  return h(
    "h3",
    { key },
    match[1],
    h("span", { className: `topic-status ${statusClass[match[2]]}` }, match[2]),
  );
}

function minutesTable(lines, i) {
  const cells = minutesTableCells(lines[i]);
  const separator = minutesTableCells(lines[i + 1] || "");
  if (
    !cells ||
    separator?.length !== cells.length ||
    !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
    return null;
  const rows = [];
  let next = i + 2;
  while (next < lines.length) {
    const row = minutesTableCells(lines[next]);
    if (!row || row.length !== cells.length) break;
    rows.push(row);
    next++;
  }
  const element = h(
    "div",
    { className: "minutes-table-wrap", key: i },
    h(
      "table",
      { className: "minutes-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          cells.map((cell, j) => h("th", { key: j, scope: "col" }, cell)),
        ),
      ),
      h(
        "tbody",
        null,
        rows.map((row, j) =>
          h(
            "tr",
            { key: j },
            row.map((cell, k) =>
              h(
                "td",
                { key: k, className: cell === "未定" ? "undecided" : undefined },
                cell,
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return { element, next };
}

// Generated minutes start with the title and 日時・参加者・記録の範囲. Print shows
// them as the cover; the screen already has its own page heading.
function minutesCover(lines, title) {
  if (lines[0] !== `# ${title}`) return { cover: null, next: 0 };
  const facts = [];
  let next = 1;
  while (
    next < lines.length &&
    (!lines[next].trim() || COVER_FIELD.test(lines[next]))
  ) {
    const field = COVER_FIELD.exec(lines[next]);
    if (field) facts.push(field.slice(1));
    next++;
  }
  const cover = h(
    "header",
    { className: "minutes-cover print-only", key: "cover" },
    h("p", { className: "minutes-eyebrow" }, "MEETING MINUTES"),
    h("h1", null, title.endsWith("議事録") ? title : `${title} 議事録`),
    facts.length
      ? h(
          "dl",
          { className: "minutes-facts" },
          facts.map(([label, value]) =>
            h("div", { key: label }, h("dt", null, label), h("dd", null, value)),
          ),
        )
      : null,
  );
  return { cover, next };
}

export function MinutesMarkdown({ content, title }) {
  const lines = content.split("\n");
  const { cover, next: start } = minutesCover(lines, title);
  const root = cover ? [cover] : [];
  const sections = [];
  let blocks = root;
  let marker = "•";
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const table = minutesTable(lines, i);
    if (table) {
      blocks.push(table.element);
      i = table.next - 1;
      continue;
    }
    if (line.startsWith("> ")) {
      const notes = [];
      while (lines[i]?.startsWith("> ")) notes.push(lines[i++].slice(2));
      i--;
      blocks.push(
        h(
          "div",
          { className: "minutes-note", key: i },
          notes.map((note, j) => h("p", { key: j }, note)),
        ),
      );
    } else if (line.startsWith("## ")) {
      blocks = [];
      sections.push({ title: line.slice(3), blocks, key: i });
      marker = line === "## 決定事項" ? "✓" : "•";
    } else if (line.startsWith("# "))
      blocks.push(h("h1", { key: i }, line.slice(2)));
    else if (line.startsWith("### ")) blocks.push(topicHeading(line.slice(4), i));
    else if (/^- \[[ x]\] /.test(line))
      blocks.push(
        h(
          "p",
          { className: "md-list md-check", key: i },
          h("span", null, line.startsWith("- [x]") ? "☑" : "☐"),
          line.slice(6),
        ),
      );
    else if (line.startsWith("- ※"))
      blocks.push(
        h(
          "p",
          { className: "md-list md-note", key: i },
          h("span", null, "•"),
          line.slice(3),
        ),
      );
    else if (line.startsWith("- "))
      blocks.push(
        h(
          "p",
          { className: "md-list", key: i },
          h("span", null, marker),
          line.slice(2),
        ),
      );
    else if (/^\s{2,}- /.test(line))
      blocks.push(
        h("p", { className: "md-sub", key: i }, line.replace(/^\s+- /, "")),
      );
    else if (!line.trim())
      blocks.push(h("div", { className: "md-space", key: i }));
    else
      blocks.push(
        h(
          "p",
          {
            key: i,
            // Text before the first section is the overview of the meeting.
            className:
              cover && blocks === root && !/^議事録形式：/.test(line)
                ? "minutes-lead"
                : undefined,
          },
          line,
        ),
      );
  }
  return h(
    "div",
    { className: "markdown" },
    root,
    sections.map((section) =>
      h(
        "section",
        {
          key: section.key,
          // Decisions open the minutes as a callout; the other sections are numbered.
          className:
            section.title === "決定事項" ? "minutes-decisions" : "minutes-section",
        },
        h("h2", null, section.title),
        section.blocks,
      ),
    ),
  );
}
