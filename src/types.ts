export interface Action {
  task: string;
  owner: string;
  due: string;
  priority?: "high" | "medium" | "low";
  category?: string;
}
export interface Minutes {
  formats?: Record<Meeting["template"], {
    summary: string;
    topics: { title: string; points: string[] }[];
  }>;
  scheduleEvents?: ScheduleEvent[];
  summary: string;
  topics: { title: string; points: string[] }[];
  decisions: string[];
  actions: Action[];
  openQuestions: string[];
  documentReview?: {
    attachmentId: string;
    relevance: string;
    summary: string;
    references: {
      location: string;
      documentEvidence: string;
      meetingEvidence: string;
      interpretation: string;
    }[];
    conflicts: string[];
    limitations: string[];
  }[];
}
export interface Attachment {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: string;
}
export interface Meeting {
  calendarOverrides?: Record<
    string,
    {
      event?: CalendarEdit;
      original: ScheduleEvent;
      analysisVersion: string;
      updatedAt: string;
      deleted?: boolean;
    }
  >;
  id: string;
  title: string;
  date: string;
  participants: string;
  createdAt: string;
  status: "bot" | "uploading" | "transcribing" | "analyzing" | "done" | "error";
  template: "standard" | "brief" | "detailed";
  source: "audio" | "text" | "demo";
  isDemo: boolean;
  hasAudio: boolean;
  fileName: string | null;
  recordings?: {
    fileName: string;
    transcribed: boolean;
    fallbackModel?: string;
  }[];
  attachments?: Attachment[];
  duration: number | null;
  transcript: string;
  markdown: string;
  markdownByFormat?: Record<Meeting["template"], string> | null;
  minutes: Minutes | null;
  segments: {
    speaker: string;
    text: string;
    start: number | null;
    end: number | null;
  }[];
  completedActions: number[];
  speakerNames: Record<string, string>;
  error: string | null;
  minutesStale: boolean;
  minutesModel?: string;
  transcriptionModel?: string;
  transcriptionWait?: {
    until: string;
    reason: "spacing" | "rate_limit";
    attempt: number;
  } | null;
  tags?: string[];
  /** Set when a Google Meet recording bot was requested for this meeting. */
  bot?: {
    requestId: string;
    meetUrl: string;
    state: "waiting" | "joining" | "recording" | "uploading" | "error";
    message: string | null;
    requestedAt: string;
    updatedAt: string;
    expiresAt: string;
    completedAt?: string;
  };
}
export type BotPhase =
  | "waiting"
  | "joining"
  | "recording"
  | "uploading"
  | "processing"
  | "done"
  | "error";
export interface BotStatusView {
  meetingId: string;
  requestId: string;
  meetUrl: string;
  state: NonNullable<Meeting["bot"]>["state"];
  phase: BotPhase;
  label: string;
  message: string | null;
  meetingStatus: Meeting["status"];
  requestedAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface Settings {
  configured: boolean;
  geminiConfigured: boolean;
  model: string;
  transcriptionModel: string;
  maxFileSize: number;
}
export interface UsageEvent {
  operation?: "summary" | "tags";
  id: string;
  meetingId: string;
  meetingTitle: string;
  runId?: string | null;
  parentRunId?: string;
  kind: "transcription" | "minutes";
  provider: "OpenAI" | "Google";
  model: string;
  createdAt: string;
  pricingDate: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  audioSeconds: number | null;
  costUsd: number | null;
  estimated: boolean;
}
export interface UsageMonth {
  month: string;
  totalUsd: number;
  unpricedCount: number;
  eventCount: number;
  events: UsageEvent[];
}
export interface ScheduleEvent {
  title: string;
  kind: "event" | "deadline";
  date: string | null;
  endDate: string | null;
  startTime: string | null;
  endTime: string | null;
  dateText: string;
  status: "confirmed" | "tentative" | "needs_confirmation";
  source: "conversation" | "document";
  attachmentId: string | null;
  location: string;
  owner: string;
  evidence: string;
}
export type CalendarEdit = Pick<
  ScheduleEvent,
  | "title"
  | "kind"
  | "date"
  | "endDate"
  | "startTime"
  | "endTime"
  | "status"
  | "location"
  | "owner"
>;
export type CalendarEntry = ScheduleEvent & {
  id: string;
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  manual: boolean;
  legacy: boolean;
  orphan: boolean;
  notes: string[];
  original: ScheduleEvent;
  sourceName: string;
  updatedAt: string | null;
};
export const isWorking = (m: Meeting) =>
  ["transcribing", "analyzing"].includes(m.status);
export const modelName = (id?: string) =>
  id === "gpt-6-luna" ? "GPT-6 Luna" :
  id === "gpt-6-sol" ? "GPT-6 Sol" : "GPT-6 Astra";
export const transcriptionModelName = (id?: string) =>
  id === "gemini-3.5-transcribe" ? "Gemini 3.5 Transcribe" : "GPT Transcribe";
export const today = () => new Intl.DateTimeFormat("sv-SE").format(new Date());
export const formatDate = (date: string) => {
  const dateObj = new Date(`${date}T12:00:00`);
  if (isNaN(dateObj.getTime())) {
    return "無効な日付";
  }
  return new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric" }).format(dateObj);
};
export const clock = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

export interface MeetingFilters {
  dateRange: { start: string; end: string } | null;
  participants: string;
  status: "all" | "done" | "working" | "error";
}

export interface SearchOptions {
  query: string;
  searchIn: {
    title: boolean;
    transcript: boolean;
    minutes: boolean;
    actions: boolean;
  };
  caseSensitive: boolean;
}

export interface MeetingTag {
  id: string;
  name: string;
  color: string;
}

export interface MeetingTemplate {
  id: string;
  name: string;
  description: string;
  defaultParticipants: string;
  defaultTopics: string[];
  templateType: "standard" | "brief" | "detailed";
  isDefault: boolean;
}
