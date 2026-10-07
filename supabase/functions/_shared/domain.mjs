import { z } from "zod";
import { minutesFormat } from "./minutes-formats.mjs";

export const MAX_FILE_SIZE = 24 * 1000 * 1000;
export const MAX_TEXT_LENGTH = 100_000;
export const audioExtensions = new Set([
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".m4a",
  ".aac",
  ".wav",
  ".webm",
  ".ogg",
  ".flac",
]);
const text = z.string();
export const MinutesSchema = z.object({
  summary: text,
  topics: z.array(z.object({ title: text, points: z.array(text) })),
  decisions: z.array(text),
  actions: z.array(z.object({ task: text, owner: text, due: text })),
  openQuestions: z.array(text),
});

export const MetadataSchema = z.object({
  title: z.string().trim().min(1, "会議名を入力してください。").max(160),
  date: z.iso.date(),
  participants: z.string().max(2000).default(""),
  template: z.enum(["standard", "brief", "detailed"]).default("standard"),
});

// Omitted options preserve the saved depth for older clients and error retries.
export const RetrySchema = z
  .object({
    template: MetadataSchema.shape.template.removeDefault().optional(),
  })
  .strict();

// Tag names are the persisted identity; there is no separate tag-ID registry.
export const TagNameSchema = z.string().trim().min(1).max(50);
export const MeetingTagsSchema = z
  .array(TagNameSchema)
  .max(50)
  .transform((names) => [...new Set(names)]);

export const PatchSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    tags: MeetingTagsSchema.optional(),
    markdown: z.string().max(150_000).optional(),
    markdownFormat: MetadataSchema.shape.template.removeDefault().optional(),
    transcript: z.string().trim().min(1).max(MAX_TEXT_LENGTH).optional(),
    completedActions: z
      .array(z.number().int().nonnegative())
      .max(500)
      .optional(),
    speakerNames: z
      .record(z.string().max(100), z.string().trim().min(1).max(100))
      .optional(),
  })
  .strict()
  .refine((patch) => patch.markdownFormat === undefined || patch.markdown !== undefined, {
    message: "編集する本文を指定してください。",
  });

export function renameMarkdownHeading(markdown, previousTitle, nextTitle) {
  const heading = /^# ([^\r\n]+)(\r?\n|$)/.exec(markdown);
  if (!heading || heading[1] !== previousTitle) return markdown;
  return `# ${nextTitle}${markdown.slice(heading[0].length - heading[2].length)}`;
}

export function minutesForFormat(minutes, format) {
  const narrative = minutes?.formats?.[format];
  return narrative ? { ...minutes, ...narrative } : minutes;
}

export function minutesDocuments(meeting, minutes) {
  const markdownByFormat = minutes.formats
    ? Object.fromEntries(Object.keys(minutes.formats).map((format) => [
        format,
        minutesToMarkdown({ ...meeting, template: format }, minutesForFormat(minutes, format)),
      ]))
    : null;
  return {
    markdown: markdownByFormat?.[meeting.template] ?? minutesToMarkdown(meeting, minutes),
    markdownByFormat,
  };
}

// Browser input may select only one saved view, never replace the whole bundle.
// Old clients without markdownFormat still edit the meeting's initial view.
export function minutesMarkdownPatch(meeting, patch) {
  const { markdownFormat, ...result } = patch;
  const selected = markdownFormat ?? meeting.template;
  if (markdownFormat !== undefined &&
      !Object.hasOwn(meeting.markdownByFormat || {}, markdownFormat)) {
    throw Object.assign(new Error("Missing minutes format"), {
      status: 400,
      publicMessage: "この形式はまだ作成されていません。3形式を再生成してください。",
    });
  }
  if (meeting.markdownByFormat) {
    const documents = { ...meeting.markdownByFormat };
    if (patch.title !== undefined) {
      for (const format of Object.keys(documents)) {
        documents[format] = renameMarkdownHeading(documents[format], meeting.title, patch.title);
      }
    }
    if (patch.markdown !== undefined) documents[selected] = patch.markdown;
    if (patch.title !== undefined || patch.markdown !== undefined) {
      result.markdownByFormat = documents;
      result.markdown = documents[meeting.template];
    }
  } else if (patch.title !== undefined && patch.markdown === undefined) {
    result.markdown = renameMarkdownHeading(meeting.markdown, meeting.title, patch.title);
  }
  return result;
}

export function timecode(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const value = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(value / 60);
  return `${String(mins).padStart(2, "0")}:${String(value % 60).padStart(
    2,
    "0",
  )}`;
}

export function transcriptFromSegments(segments, names = {}) {
  return segments
    .map(
      (s) =>
        `${s.start === null ? "" : `[${timecode(s.start)}] `}${
          names[s.speaker] || s.speaker
        }：${s.text}`,
    )
    .join("\n\n");
}

export function minutesToMarkdown(meeting, minutes) {
  const lines = [
    `# ${meeting.title}`,
    "",
    `日時：${meeting.date}`,
    `参加者：${meeting.participants || "未記入"}`,
    "",
    `議事録形式：${minutesFormat(meeting.template).label}`,
    "",
    "## 内容要旨",
    "",
    minutes.summary,
  ];
  if (minutes.decisions.length) {
    lines.push(
      "",
      "## 決定事項",
      "",
      ...minutes.decisions.map((d) => `- ${d}`),
    );
  }
  const nextMeetings = minutes.topics.filter(
    (topic) => topic.title.trim() === "次回会議",
  );
  const topics = minutes.topics.filter(
    (topic) => topic.title.trim() !== "次回会議",
  );
  if (topics.length) lines.push("", "## 議事内容");
  for (const topic of topics) {
    lines.push(
      "",
      `### ${topic.title}`,
      "",
      ...topic.points.map((p) => `- ${p}`),
    );
  }
  if (minutes.actions.length) {
    const cell = (value) =>
      value
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/[\r\n]+/g, " ");
    lines.push(
      "",
      "## 次の対応",
      "",
      "| 対応内容 | 担当 | 期限・時期 |",
      "| --- | --- | --- |",
      ...minutes.actions.map(
        (a) =>
          `| ${cell(a.task)} | ${cell(a.owner || "未定")} | ${cell(a.due || "未定")} |`,
      ),
    );
  }
  if (minutes.openQuestions.length) {
    lines.push(
      "",
      "## 継続検討・確認事項",
      "",
      ...minutes.openQuestions.map((q) => `- ${q}`),
    );
  }
  if (nextMeetings.length) {
    lines.push(
      "",
      "## 次回会議",
      "",
      ...nextMeetings.flatMap((topic) =>
        topic.points.map((point) => `- ${point}`),
      ),
    );
  }
  if (minutes.documentReview?.length) {
    lines.push("", "## 添付資料との照合", "");
    for (const review of minutes.documentReview) {
      const attachment = meeting.attachments?.find(
        (f) => f.id === review.attachmentId,
      );
      lines.push(
        `### ${attachment?.name || "添付資料"} — ${review.relevance}`,
        "",
        review.summary,
      );
      for (const ref of review.references) {
        lines.push(
          "",
          `- 参照箇所：${ref.location}`,
          `- 資料の根拠：${ref.documentEvidence}`,
          `- 会話の根拠：${ref.meetingEvidence}`,
          `- 照合結果：${ref.interpretation}`,
        );
      }
      if (review.conflicts.length) {
        lines.push(
          "",
          "照合で見つかった相違・要確認",
          ...review.conflicts.map((v) => `- ${v}`),
        );
      }
      if (review.limitations.length) {
        lines.push(
          "",
          "読み取り範囲・注意",
          ...review.limitations.map((v) => `- ${v}`),
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function safeError(error) {
  if (error.code === "GEMINI_QUOTA_EXHAUSTED") {
    return "Geminiの日次上限、または利用できる枠の不足を検出しました。Google AI Studioで利用枠・請求設定を確認し、利用可能になってから再試行してください。完了した文字起こしは保存されています。";
  }
  if (error.code === "GEMINI_RETRIES_EXHAUSTED") {
    return "Geminiの利用制限が続き、自動再試行5回でも完了しませんでした。しばらく待つか利用枠を確認して再試行してください。完了した文字起こしは保存されています。";
  }
  if (error.code === "GEMINI_UPLOAD_START_NETWORK") {
    return "Gemini APIキーの確認通信を開始できませんでした。Google APIへのネットワーク接続を確認して再試行してください。";
  }
  if (error.code === "GEMINI_UPLOAD_BODY_NETWORK") {
    return "GeminiはAPIキーを受理しましたが、音声データの送信中に通信エラーが発生しました。再試行してください。";
  }
  if (error.code === "GEMINI_FILE_STATUS_NETWORK") {
    return "Geminiへの音声送信後、処理状態を確認できませんでした。再試行してください。";
  }
  if (error.code === "GEMINI_TRANSCRIBE_NETWORK") {
    return "Geminiへの音声送信は成功しましたが、文字起こし結果の取得中に通信エラーが発生しました。再試行してください。";
  }
  if (error.code === "GEMINI_UPLOAD_RESULT_INVALID") {
    return "GeminiはAPIキーと音声を受理しましたが、アップロード結果を正しく返しませんでした。しばらくしてから再試行してください。";
  }
  if (error.code === "GEMINI_FILE_STATUS_INVALID") {
    return "Geminiへの音声送信は成功しましたが、処理状態の応答を読み取れませんでした。再試行してください。";
  }
  if (error.code === "GEMINI_TRANSCRIPT_INVALID") {
    return "Geminiへの音声送信は成功しましたが、文字起こし応答を読み取れませんでした。再試行してください。";
  }
  if (error.code === "GEMINI_TRANSCRIPT_INCOMPLETE") {
    return `Geminiの文字起こしが完了しませんでした（Geminiの状態：${error.geminiStatus || "unknown"}${
      error.geminiStatus === "incomplete"
        ? "。出力の上限に達したなどで結果が途中まででした"
        : ""
    }）。保存済みの音声から再試行してください。`;
  }
  if (error.code === "GEMINI_NO_TRANSCRIPT") {
    return "Geminiは処理を完了しましたが、文字起こしが空でした。録音を再生して確認し、再試行するか文字起こしモデルを変更してください。";
  }
  if (error.code === "GEMINI_UPLOAD_URL_MISSING") {
    return "GeminiはAPIキーを受理しましたが、音声アップロード先を返しませんでした。キーのAPI制限とGenerative Language APIの設定を確認してください。";
  }
  if (error.code === "GEMINI_UPLOAD_RESULT_MISSING") {
    return "Geminiは音声を受け取りましたが、ファイル情報を返しませんでした。しばらくしてから再試行してください。";
  }
  if (error.code === "GEMINI_FILE_NOT_READY") {
    return "Geminiへの音声保存は成功しましたが、文字起こし可能な状態になるまでに時間がかかっています。しばらくしてから再試行してください。";
  }
  if (error.status === 401) {
    return "APIキーを確認してください。接続設定から更新できます。";
  }
  if (error.provider === "gemini" && error.status === 403) {
    return "Gemini APIキーは認証されましたが、このAPIまたはモデルを利用する権限がありません。Google AI Studio / Google CloudでGenerative Language APIの有効化、キーの制限、請求設定を確認してください。";
  }
  if (error.status === 429) {
    return "AIの利用上限または混雑により処理できませんでした。利用枠を確認して再試行してください。";
  }
  if (error.status === 413) {
    return "AIへ送るデータが大きすぎます。資料を分けるか、録音を短くして再度取り込んでください。";
  }
  if (error.status === 400) {
    return "AIへの入力が受け付けられませんでした。音声や資料の形式・サイズ、資料のパスワード保護、モデルの利用条件を確認してください。";
  }
  if (error.status === 404) {
    return "AIモデルを利用できません。モデル設定とAPIの利用権限を確認してください。";
  }
  if (error.provider === "gemini" && error.status >= 500) {
    return "Gemini側で一時的なエラーが発生しました。しばらくしてから再試行してください。";
  }
  if (
    error.name === "APIConnectionTimeoutError" ||
    error.name === "AbortError"
  ) {
    return "処理がタイムアウトしました。しばらくしてから再試行してください。";
  }
  if (error.code === "EMPTY_AUDIO") {
    return "音声から発話を検出できませんでした。録音内容をご確認ください。";
  }
  if (error.code === "TEXT_TOO_LONG") {
    return "文字起こしが10万文字を超えました。会議を分割して取り込んでください。";
  }
  return "AI処理を完了できませんでした。保存済みの文字起こしは残っています。接続を確認して再試行してください。";
}
