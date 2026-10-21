import { minutesToMarkdown, transcriptFromSegments } from "./domain.mjs";

export function createDemo() {
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  const meeting = {
    id: crypto.randomUUID(),
    title: "新サービスのリリースに向けた定例会議",
    date,
    participants: "田中、佐藤、鈴木",
    template: "standard",
    createdAt: new Date().toISOString(),
    status: "done",
    source: "demo",
    isDemo: true,
    fileName: null,
    audioFile: null,
    duration: 124,
    error: null,
    completedActions: [],
    speakerNames: {},
    minutesStale: false,
    segments: [
      {
        speaker: "田中",
        start: 0,
        end: 21,
        text: "今日は新サービスのリリース準備を確認します。まず、公開日は10月15日のままで進めましょう。初回は既存のお客様向けに限定して公開する方針でよいですか。",
      },
      {
        speaker: "佐藤",
        start: 22,
        end: 43,
        text: "はい、その方針で問題ありません。デザインはほぼできています。私のほうで10月2日までに最終デザインを共有します。スマートフォンの表示も合わせて確認します。",
      },
      {
        speaker: "鈴木",
        start: 44,
        end: 68,
        text: "開発側も賛成です。決済機能の結合テストが残っているので、私が10月8日までに完了させます。エラー時の表示についてはデザインを確認してから調整したいです。",
      },
      {
        speaker: "田中",
        start: 69,
        end: 91,
        text: "では、10月15日に既存のお客様限定で公開することで決定します。案内メールは私が10月10日までに作成します。一般公開の時期は初回の反応を見てから改めて決めましょう。",
      },
      {
        speaker: "佐藤",
        start: 92,
        end: 106,
        text: "一般公開時の料金プランはまだ決まっていませんね。次回、比較できるように案を持ち寄るのはどうでしょう。",
      },
      {
        speaker: "田中",
        start: 107,
        end: 124,
        text: "そうですね。料金プランは継続検討にします。担当や期限はまだ決めず、次回の議題にしましょう。今日は以上です。",
      },
    ],
  };
  meeting.transcript = transcriptFromSegments(meeting.segments);
  meeting.minutes = {
    scheduleEvents: [],
    summary:
      "新サービスの公開に向け、デザイン・開発・お客様への案内の進捗を確認しました。10月15日に既存のお客様限定で公開する方針を決定。最終デザイン、結合テスト、案内メールの担当と期限を整理しました。一般公開の時期と料金プランは引き続き検討します。",
    topics: [
      {
        title: "リリース方針とスケジュール",
        status: "決定",
        points: [
          "10月15日に既存のお客様向けに限定公開する。",
          "一般公開の時期は、限定公開後のお客様の反応を見て判断する。",
        ],
      },
      {
        title: "デザイン・開発の進捗",
        status: "報告",
        points: [
          "デザインはほぼ完成。スマートフォン表示の確認を含め、10月2日までに最終版を共有する。",
          "決済機能の結合テストを10月8日までに完了する。エラー表示は最終デザインを確認して調整する。",
        ],
        notes: ["エラー表示をどこまで変更するかは、会議中に決まっていない。"],
      },
    ],
    recordScope: "会議全体",
    decisions: [
      "10月15日に既存のお客様限定でサービスを公開する。",
      "料金プランは次回の会議で継続検討する。",
    ],
    decisionNotes: [
      "一般公開の時期は、限定公開後のお客様の反応を見て判断します。",
      "",
    ],
    actions: [
      {
        task: "最終デザインの共有とスマートフォン表示の確認",
        owner: "佐藤",
        due: "10月2日",
      },
      { task: "決済機能の結合テストを完了する", owner: "鈴木", due: "10月8日" },
      {
        task: "既存のお客様向けの案内メールを作成する",
        owner: "田中",
        due: "10月10日",
      },
    ],
    openQuestions: [
      "一般公開の時期",
      "一般公開時の料金プランと、検討の担当者・期限",
    ],
    recordNotes: ["操作確認用の架空の会議です。"],
  };
  meeting.markdown = minutesToMarkdown(meeting, meeting.minutes);
  return meeting;
}
