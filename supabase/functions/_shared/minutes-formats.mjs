// Shared by the browser, local API and Edge Function. Persisted IDs stay stable.
export const MINUTES_FORMATS = Object.freeze([
  Object.freeze({
    id: "brief",
    label: "要約版",
    description: "主な方針・決定事項と、次の対応を短く整理します。",
    instruction:
      "要点を簡潔にまとめる。内容要旨は短い段落とし、topicsは結論の理解に不可欠な議題だけに絞る。背景説明は必要最小限にする。ただし重要な決定・作業・担当・期限・未解決事項は省略しない。",
  }),
  Object.freeze({
    id: "standard",
    label: "標準版",
    description: "議題ごとの結論に、必要な背景・経緯を添えて整理します。",
    instruction:
      "要点を適度に詳しくまとめる。topicsは議題ごとに結論・現在の状態を先に示し、その判断に必要な背景・経緯・理由を簡潔に続ける。発言を逐一再現せず、第三者が結論と次の対応を理解できる分量にする。",
  }),
  Object.freeze({
    id: "detailed",
    label: "詳細版（背景も詳しく）",
    description: "結論に加え、背景・理由・異論・検討の経緯を詳しく残します。",
    instruction:
      "背景、理由、異論も詳しくまとめる。topicsは必要に応じて議題を小分けにし、結論・現在の状態、背景、検討の経緯、根拠となる数値、代替案・異論、未確定の条件を会話の範囲で整理する。発言の丸写しや同じ内容の繰り返しは避ける。",
  }),
]);

export const MINUTES_FORMAT_GUIDANCE =
  "共通構成：内容要旨 → 決定事項 → 議題別の内容 → 次の対応（担当・期限） → 継続検討・確認事項 → 次回会議。会議内容に応じて項目・議題の分け方・分量を調整し、該当しない項目は省略します。ページ数は固定しません。";

export function minutesFormat(id) {
  return (
    MINUTES_FORMATS.find((format) => format.id === id) || MINUTES_FORMATS[1]
  );
}

export function defaultMinutesTemplates() {
  return MINUTES_FORMATS.map((format) => ({
    id: `format-${format.id}`,
    name: format.label,
    description: format.description,
    defaultParticipants: "",
    defaultTopics: [],
    templateType: format.id,
    isDefault: true,
  }));
}

export function isMinutesFormatTemplate(template) {
  return MINUTES_FORMATS.some(
    (format) => template.id === `format-${format.id}`,
  );
}
