import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cardHtml } from "../supabase/functions/_shared/qr-card.mjs";

const endpoint = process.env.QR_HTML_CARDS_URL;
const dist = process.argv[2] || "dist";
if (!endpoint) {
  console.error("QR_HTML_CARDS_URL is required");
  process.exit(1);
}
const response = await fetch(endpoint);
if (!response.ok) {
  console.error(`card list failed: ${response.status}`);
  process.exit(1);
}
const cards = await response.json();
if (!Array.isArray(cards)) {
  console.error("card list is not an array");
  process.exit(1);
}
const dir = path.join(dist, "s");
await mkdir(dir, { recursive: true });
for (const card of cards) {
  if (!/^[A-Za-z0-9_-]{12}$/.test(card.code) || typeof card.name !== "string") {
    console.error("invalid card");
    process.exit(1);
  }
  await writeFile(path.join(dir, `${card.code}.html`), cardHtml(card.name, card.code));
}
console.log(`wrote ${cards.length} HTML cards`);
