import { createElement as h } from "react";

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

export function MinutesMarkdown({ content, title }) {
  const lines = content.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cells = minutesTableCells(line);
    const separator = minutesTableCells(lines[i + 1] || "");
    if (
      cells &&
      separator?.length === cells.length &&
      separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      const start = i;
      const rows = [];
      i += 2;
      while (i < lines.length) {
        const row = minutesTableCells(lines[i]);
        if (!row || row.length !== cells.length) break;
        rows.push(row);
        i++;
      }
      i--;
      blocks.push(
        h(
          "div",
          { className: "minutes-table-wrap", key: start },
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
                  row.map((cell, k) => h("td", { key: k }, cell)),
                ),
              ),
            ),
          ),
        ),
      );
      continue;
    }
    // Retain generated metadata for print; the screen has its own page heading.
    const header =
      lines[0] === `# ${title}` &&
      i < 4 &&
      (i === 0 || /^(日時|参加者)：/.test(line));
    if (header) {
      blocks.push(
        h(
          i === 0 ? "h1" : "p",
          { key: i, className: "print-only" },
          i === 0 ? line.slice(2) : line,
        ),
      );
    } else if (line.startsWith("# "))
      blocks.push(h("h1", { key: i }, line.slice(2)));
    else if (line.startsWith("## "))
      blocks.push(h("h2", { key: i }, line.slice(3)));
    else if (line.startsWith("### "))
      blocks.push(h("h3", { key: i }, line.slice(4)));
    else if (/^- \[[ x]\] /.test(line))
      blocks.push(
        h(
          "p",
          { className: "md-list", key: i },
          h("span", null, line.startsWith("- [x]") ? "☑" : "☐"),
          line.slice(6),
        ),
      );
    else if (line.startsWith("- "))
      blocks.push(
        h(
          "p",
          { className: "md-list", key: i },
          h("span", null, "•"),
          line.slice(2),
        ),
      );
    else
      blocks.push(
        line.trim()
          ? h("p", { key: i }, line)
          : h("div", { className: "md-space", key: i }),
      );
  }
  return h("div", { className: "markdown" }, blocks);
}
