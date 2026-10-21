// Store names of the MARUGO group, as written on the company site
// (https://05-marugo-group.com/brands.html). Meetings mention them often and
// speech models tend to hear 「マルゴ」 as a common word such as 「丸5」.
export const GROUP_STORE_NAMES = Object.freeze([
  "マルゴ",
  "マルゴ セカンド",
  "マルゴ グランデ",
  "マルゴ オット",
  "マルゴ 四谷",
  "マルゴ 新橋",
  "マルゴ丸の内",
  "マルゴエス",
  "マルゴ D",
  "焼肉マルゴ",
  "サンナナイチ バル",
  "居酒屋割烹 三三五五",
  "シェンロン&クラウディア",
  "クラウディア2",
  "ソバージュ",
  "バルペロタ",
  "トラットリア ブリッコラ",
  "ヴィオレット",
  "元祖どないや 新宿三丁目店",
  "鮨こるり",
  "ビストロ サヴァサヴァ",
  "エリックスバイ エリックトロション",
  "ミタン",
  "ブルネロ",
]);

export const STORE_NAME_GUIDANCE = `会話はマルゴグループ（飲食店の会社）の社内会議。グループの店舗名の正式表記は次のとおり：${GROUP_STORE_NAMES.join("、")}。文字起こしは店舗名を音の近い別の語で誤記していることがある（例：「丸5」「丸ご」は「マルゴ」、「丸5セカンド」は「マルゴ セカンド」）。前後の文脈から店舗名を指していると判断できる場合だけ、議事録では正式表記で書き、storeNameFixesに文字起こし中の誤記（heard。文字起こしにある文字列そのまま）と正式な店舗名（store）を1組ずつ入れる。「丸の内」「四谷」「新橋」などの地名だけの言及、人名、店舗を指すか判断できない語は変えず、storeNameFixesにも入れない。該当がなければstoreNameFixesは空。`;

const MAX_HEARD_LENGTH = 20;

// Applies only well-formed fixes the transcript actually contains. Every
// occurrence is replaced in one pass, so a replacement is never rewritten again.
export function applyStoreNameFixes(transcript, fixes) {
  const stores = new Set(GROUP_STORE_NAMES);
  const accepted = new Map();
  for (const fix of Array.isArray(fixes) ? fixes : []) {
    const raw = typeof fix?.heard === "string" ? fix.heard : "";
    const heard = raw.trim();
    const store = fix?.store;
    if (!heard || heard.length > MAX_HEARD_LENGTH || /[\r\n]/.test(raw)) continue;
    if (!stores.has(store) || heard === store) continue;
    // Never touch text that is already part of a correct store name.
    if (GROUP_STORE_NAMES.some((name) => name.includes(heard))) continue;
    if (!transcript.includes(heard) || accepted.has(heard)) continue;
    accepted.set(heard, store);
  }
  if (!accepted.size) return { transcript, applied: [] };
  const heardList = [...accepted.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    heardList.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  const counts = new Map();
  const next = transcript.replace(pattern, (match) => {
    counts.set(match, (counts.get(match) || 0) + 1);
    return accepted.get(match);
  });
  return {
    transcript: next,
    applied: heardList
      .filter((heard) => counts.get(heard))
      .map((heard) => ({ heard, store: accepted.get(heard), count: counts.get(heard) })),
  };
}
