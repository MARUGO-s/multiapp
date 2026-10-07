import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  BookOpen,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileAudio,
  FileText,
  FolderOpen,
  LayoutGrid,
  ListTodo,
  LoaderCircle,
  Menu,
  MessageSquareText,
  Pencil,
  Plus,
  ReceiptText,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
  Filter,
  Tag as TagIcon,
  Trash2,
  TrendingUp,
  GitCompare,
} from "lucide-react";
import { api, download, exportMultipleMeetings } from "./api";
import { formatDuration } from "../supabase/functions/_shared/duration.mjs";
import { isCloud, signOut, getSession } from "./cloud";
import { signOutGoogleAccount } from "./portal-google-client";
import {
  formatDate,
  isWorking,
  modelName,
  transcriptionModelName,
  today,
  type Meeting,
  type Settings,
  type MeetingFilters,
  type MeetingTag,
  type SearchOptions,
  type MeetingTemplate,
  type ScheduleEvent,
} from "./types";
import { NewMeeting } from "./NewMeeting";
import { SettingsDialog } from "./SettingsDialog";
import { ActionList, MeetingDetail } from "./MeetingDetail";
import { Calendar } from "./Calendar";
import { UsagePage } from "./UsagePage";
import { StatsPage } from "./StatsPage";
import { ComparePage } from "./ComparePage";
import { Modal } from "./Modal";
import { TagSuggestionDialog } from "./TagSuggestionDialog";
import { createTagCompletionTracker, createTagSuggestionCache } from "./tag-suggestions.mjs";
import { meetingEvents, tokyoToday } from "../supabase/functions/_shared/calendar.mjs";
import { MeetingTagsSchema, TagNameSchema } from "../supabase/functions/_shared/domain.mjs";
import { defaultMinutesTemplates } from "../supabase/functions/_shared/minutes-formats.mjs";
import { BOT_PHASE_LABELS, botActive, botPhase } from "../supabase/functions/_shared/bot.mjs";

const TAG_CANDIDATES_KEY = "kotonoha.tag-candidates.v1";
const NOTIFIED_DEADLINES_KEY = "kotonoha.notified-deadlines.v1";
function storedStrings(storage: Storage, key: string): string[] {
  const value: unknown = JSON.parse(storage.getItem(key) || "[]");
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}
function meetingTag(name: string): MeetingTag {
  const colors = ["#6960d8", "#247b6e", "#ad5b28", "#ad4575", "#326db0", "#78702b"];
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  // Use the name for both UI identity and the value saved in Meeting.tags.
  return { id: name, name, color: colors[hash % colors.length] };
}

type Page = "meetings" | "calendar" | "actions" | "usage" | "stats" | "compare" | "help";
export default function App({ onChooseApp }: { onChooseApp: () => void }) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<Page>("meetings");
  const [calendarDate, setCalendarDate] = useState(tokyoToday);
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchOptions, setSearchOptions] = useState<SearchOptions>({
    query: "",
    searchIn: {
      title: true,
      transcript: true,
      minutes: true,
      actions: true,
    },
    caseSensitive: false,
  });
  const [showSearchOptions, setShowSearchOptions] = useState(false);
  const [filter, setFilter] = useState("all");
  const [advancedFilters, setAdvancedFilters] = useState<MeetingFilters>({
    dateRange: null,
    participants: "",
    status: "all",
  });
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [tagCandidates, setTagCandidates] = useState<string[]>(() => {
    try {
      return MeetingTagsSchema.parse(storedStrings(localStorage, TAG_CANDIDATES_KEY));
    } catch { return []; }
  });
  const tags = [...new Set([...meetings.flatMap((m) => m.tags || []), ...tagCandidates])]
    .sort().map(meetingTag);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(null);
  const [showTagManager, setShowTagManager] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const tagMutation = useRef({ busy: false, version: 0 });
  const [tagAssignmentTarget, setTagAssignmentTarget] = useState<string | null>(null);
  const tagCompletion = useRef(createTagCompletionTracker());
  const tagRequests = useRef(createTagSuggestionCache());
  const [aiTagQueue, setAiTagQueue] = useState<{ id: string; key: string }[]>([]);
  const [templates, setTemplates] = useState<MeetingTemplate[]>([]);
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>("default");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [demoLoading, setDemoLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const renameInput = useRef<HTMLInputElement>(null);
  const latestMeetings = useRef(meetings);
  const notifiedDeadlines = useRef<Set<string> | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(TAG_CANDIDATES_KEY, JSON.stringify(tagCandidates));
    } catch { /* Candidates remain usable when browser storage is unavailable. */ }
  }, [tagCandidates]);

  // デフォルトテンプレート
  useEffect(() => {
    setTemplates(defaultMinutesTemplates() as MeetingTemplate[]);
  }, []);

  // 通知権限のチェック
  useEffect(() => {
    if ("Notification" in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  const checkOverdueActions = useCallback(() => {
    if (!("Notification" in window) || notificationPermission !== "granted" ||
        Notification.permission !== "granted") return;
    if (!notifiedDeadlines.current) {
      try {
        notifiedDeadlines.current = new Set(storedStrings(sessionStorage, NOTIFIED_DEADLINES_KEY));
      } catch { notifiedDeadlines.current = new Set(); }
    }
    const notified = notifiedDeadlines.current;
    const today = tokyoToday();
    const pending = latestMeetings.current.filter((m) => !m.isDemo).flatMap((m) =>
      meetingEvents(m).flatMap((event: ScheduleEvent & { id: string; original: ScheduleEvent }) => {
        const due = event.endDate || event.date;
        if (event.kind !== "deadline" || event.status !== "confirmed" || !due || due >= today) return [];
        // Calendar edits preserve the original title/owner, so completion still matches.
        const actions = (m.minutes?.actions || []).flatMap((action, index) =>
          action.task === event.original.title && action.owner === event.original.owner ? [index] : [],
        );
        if (actions.length && actions.every((index) => m.completedActions?.includes(index))) return [];
        const key = JSON.stringify([m.id, event.id, due]);
        return notified.has(key) ? [] : [key];
      }),
    );
    if (!pending.length) return;
    try {
      new Notification("期限を過ぎた予定があります", {
        body: `共有カレンダーに${pending.length}件の未通知の期限があります`,
        tag: "kotonoha-overdue",
      });
    } catch { return; } // Some browsers cannot construct notifications; never break the app.
    pending.forEach((key) => notified.add(key));
    try {
      sessionStorage.setItem(NOTIFIED_DEADLINES_KEY, JSON.stringify([...notified]));
    } catch { /* In-memory deduplication still works. */ }
  }, [notificationPermission]);
  useEffect(() => {
    latestMeetings.current = meetings;
    checkOverdueActions();
  }, [meetings, checkOverdueActions]);
  useEffect(() => {
    if (notificationPermission !== "granted") return;
    // Stable across polling; check day rollover even when meeting data does not change.
    const interval = setInterval(checkOverdueActions, 60_000);
    return () => clearInterval(interval);
  }, [notificationPermission, checkOverdueActions]);

  async function requestNotificationPermission() {
    if ("Notification" in window) {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === "granted") {
        notify("通知を有効にしました。アプリを開いている間だけ期限を確認します。");
      }
    }
  }
  useEffect(() => {
    if (!renameTarget) return;
    const frame = requestAnimationFrame(() => renameInput.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [renameTarget]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  }, []);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const refresh = useCallback(async () => {
    const tagVersion = tagMutation.current.version;
    try {
      const [records, config] = await Promise.all([
        api<Meeting[]>("/meetings"),
        api<Settings>("/settings"),
      ]);
      if (!tagMutation.current.busy && tagMutation.current.version === tagVersion) setMeetings(records);
      setSettings(config);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const processing = meetings.some(isWorking);
  // While a Meet bot is waiting/recording/uploading, refresh the list a little faster.
  const botWaiting = meetings.some((m) => botActive(m));
  useEffect(() => {
    const completed = tagCompletion.current.observe(meetings);
    setAiTagQueue(previous => {
      const valid = previous.filter(item => meetings.some(m => m.id === item.id && m.status === "done" && !m.isDemo && m.minutes) && item.key === tagCompletion.current.key(item.id));
      return [...valid, ...completed.filter(item => !valid.some(queued => queued.key === item.key))];
    });
  }, [meetings]);
  useEffect(() => {
    if ((!processing && !isCloud) || editing || renameTarget) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const tagVersion = tagMutation.current.version;
      try {
        const records = await api<Meeting[]>("/meetings");
        const config = isCloud ? await api<Settings>("/settings") : null;
        if (!stop) {
          if (!tagMutation.current.busy && tagMutation.current.version === tagVersion) setMeetings(records);
          if (config) setSettings(config);
          setError("");
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stop) timer = setTimeout(poll, processing ? 2500 : botWaiting ? 5000 : 10000);
    }
    timer = setTimeout(poll, processing ? 2500 : botWaiting ? 5000 : 10000);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [processing, botWaiting, editing, renameTarget, isCloud]);
  function updateMeeting(next: Meeting) {
    setMeetings((prev) =>
      prev.some((m) => m.id === next.id)
        ? prev.map((m) => (m.id === next.id ? next : m))
        : [next, ...prev],
    );
  }
  function openRename(meeting: Meeting) {
    setRenameTarget(meeting.id);
    setRenameDraft(meeting.title);
    setRenameError("");
    setSidebarOpen(false);
  }
  async function saveRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = renameDraft.trim();
    if (!renameTarget || !title || title.length === 0 || title.length > 160) return;
    setRenameBusy(true);
    setRenameError("");
    try {
      const updated = await api<Meeting>(`/meetings/${renameTarget}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      updateMeeting(updated);
      setRenameTarget(null);
      notify("会議名を変更しました。共有画面にも反映されます。");
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : String(e));
    } finally {
      setRenameBusy(false);
    }
  }
  function go(next: Page) {
    setPage(next);
    setSelected(null);
    setSidebarOpen(false);
    setSearch("");
  }
  function openMeeting(id: string) {
    setSelected(id);
    if (page !== "calendar") setPage("meetings");
    setSidebarOpen(false);
    window.scrollTo({ top: 0 });
  }
  async function demo() {
    setDemoLoading(true);
    try {
      const m = await api<Meeting>("/demo", { method: "POST" });
      updateMeeting(m);
      openMeeting(m.id);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setDemoLoading(false);
    }
  }
  async function create(data: FormData, progress: (message: string) => void) {
    const m =
      data.getAll("audio").length || data.getAll("attachment").length
        ? await (
            await import("./upload-recordings")
          ).uploadRecordings(data, progress)
        : await api<Meeting>("/meetings", { method: "POST", body: data });
    tagCompletion.current.expect(m.id);
    updateMeeting(m);
    setNewOpen(false);
    openMeeting(m.id);
  }
  async function requestBot(request: {
    meetUrl: string;
    metadata: { title: string; date: string; participants: string; template: string };
  }) {
    const m = await api<Meeting>("/bot/requests", {
      method: "POST",
      body: JSON.stringify(request),
    });
    tagCompletion.current.expect(m.id);
    updateMeeting(m);
    setNewOpen(false);
    openMeeting(m.id);
    notify("Botに参加を依頼しました。状況は会議の画面に表示されます。");
  }

  // タグ管理関数
  function openAiTags(meeting: Meeting) {
    const item = { id: meeting.id, key: tagCompletion.current.key(meeting.id) };
    setAiTagQueue(previous => [item, ...previous.filter(queued => queued.key !== item.key)]);
  }
  const aiTagTarget = aiTagQueue[0];
  const aiTagMeeting = meetings.find(m => m.id === aiTagTarget?.id && m.status === "done");
  async function loadAiTags(retry = false): Promise<string[]> {
    if (!aiTagTarget) return [];
    return tagRequests.current(aiTagTarget.key, async () => {
      const result = await api<{ tags: string[] }>("/suggest-tags", {
        method: "POST", body: JSON.stringify({ meetingId: aiTagTarget.id }),
      });
      return MeetingTagsSchema.parse(result.tags);
    }, retry);
  }
  async function saveAiTags(selectedTags: string[]) {
    if (!aiTagTarget || tagMutation.current.busy) throw new Error("タグを保存中です。少し待ってから再試行してください。");
    const target = aiTagTarget;
    tagMutation.current.busy = true;
    tagMutation.current.version++;
    setTagBusy(true);
    try {
      // Merge against the latest server tags instead of the popup's old snapshot.
      const fresh = await api<Meeting>(`/meetings/${target.id}`);
      if (fresh.status !== "done" || fresh.isDemo || target.key !== tagCompletion.current.key(target.id)) {
        throw new Error("会議の状態が変わりました。解析完了後にタグ候補を開き直してください。");
      }
      const merged = MeetingTagsSchema.safeParse([...new Set([...(fresh.tags || []), ...selectedTags])]);
      if (!merged.success) throw new Error("タグは各50文字以内、1会議50個まで設定できます。");
      const updated = await api<Meeting>(`/meetings/${target.id}`, {
        method: "PATCH", body: JSON.stringify({ tags: merged.data }),
      });
      updateMeeting(updated);
      setTagCandidates(prev => prev.filter(name => !updated.tags?.includes(name)));
      notify("選んだタグを議事録に保存しました。");
    } finally {
      tagMutation.current.busy = false;
      tagMutation.current.version++;
      setTagBusy(false);
    }
  }

  function createTag() {
    const parsed = TagNameSchema.safeParse(newTagName);
    if (!parsed.success) return notify("タグ名は1〜50文字で入力してください。");
    if (tags.some((tag) => tag.name === parsed.data)) return notify("同じ名前のタグがあります。");
    if (tagCandidates.length >= 50) return notify("未使用のタグ候補を削除してから追加してください。");
    setTagCandidates((prev) => [...prev, parsed.data]);
    setNewTagName("");
    notify("タグ候補を追加しました。会議に付けると共有保存されます。");
  }

  function deleteTag(tagId: string) {
    if (meetings.some((m) => m.tags?.includes(tagId))) return;
    setTagCandidates((prev) => prev.filter((name) => name !== tagId));
    if (selectedTagFilter === tagId) setSelectedTagFilter(null);
    notify("この端末のタグ候補を削除しました");
  }

  async function toggleMeetingTag(meetingId: string, tagId: string) {
    const meeting = meetings.find((m) => m.id === meetingId);
    if (!meeting || tagMutation.current.busy) return;
    
    const currentTags = meeting.tags || [];
    const updatedTags = currentTags.includes(tagId)
      ? currentTags.filter((t) => t !== tagId)
      : [...currentTags, tagId];
    
    const parsed = MeetingTagsSchema.safeParse(updatedTags);
    if (!parsed.success) return notify("タグは各50文字以内、1会議50個まで設定できます。");
    tagMutation.current.busy = true;
    tagMutation.current.version++;
    setTagBusy(true);
    try {
      const updated = await api<Meeting>(`/meetings/${meetingId}`, {
        method: "PATCH",
        body: JSON.stringify({ tags: parsed.data }),
      });
      updateMeeting(updated);
      setTagCandidates((prev) => prev.filter((name) => !updated.tags?.includes(name)));
      notify("タグを保存しました。共有画面にも反映されます。");
    } catch (e) {
      notify(`タグを保存できませんでした。${e instanceof Error ? e.message : String(e)}`);
    } finally {
      tagMutation.current.busy = false;
      tagMutation.current.version++;
      setTagBusy(false);
    }
  }

  function handleExport(format: "markdown" | "json" | "ics") {
    const content = exportMultipleMeetings(filtered, format);
    const filename = `会議録一括エクスポート_${new Date().toISOString().split("T")[0]}.${format === "ics" ? "ics" : format === "json" ? "json" : "md"}`;
    const mimeType = format === "ics" ? "text/calendar" : format === "json" ? "application/json" : "text/markdown";
    download(filename, content, mimeType);
    setShowExportDialog(false);
  }
  const realMeetings = meetings.filter((m) => !m.isDemo);
  const actionCount = realMeetings.reduce(
    (count, m) =>
      count + (m.minutes?.actions?.length || 0) - (m.completedActions?.length || 0),
    0,
  );
  const current = meetings.find((m) => m.id === selected);
  const filtered = meetings.filter((m) => {
    // 基本フィルター
    const basicFilter =
      filter === "all" ||
      (filter === "done" ? m.status === "done" : isWorking(m)) ||
      (filter === "processing" ? isWorking(m) : false);

    // 詳細検索フィルター
    const searchFilter = (() => {
      if (!search && !searchOptions.query) return true;
      const query = (search || searchOptions.query).trim();
      if (!query) return true;
      
      const searchTargets: string[] = [];
      if (searchOptions.searchIn.title) searchTargets.push(m.title);
      if (searchOptions.searchIn.transcript) searchTargets.push(m.transcript);
      if (searchOptions.searchIn.minutes) searchTargets.push(m.markdown);
      if (searchOptions.searchIn.actions) {
        const actions = m.minutes?.actions?.map(a => a.task).join(" ") || "";
        searchTargets.push(actions);
      }
      
      const targetText = searchTargets.join(" ");
      const compareQuery = searchOptions.caseSensitive ? query : query.toLowerCase();
      const compareTarget = searchOptions.caseSensitive ? targetText : targetText.toLowerCase();
      
      return compareTarget.includes(compareQuery);
    })();

    // 高度なフィルター
    const statusFilter =
      advancedFilters.status === "all" ||
      (advancedFilters.status === "done" ? m.status === "done" : false) ||
      (advancedFilters.status === "working" ? isWorking(m) : false) ||
      (advancedFilters.status === "error" ? m.status === "error" : false);

    const participantsFilter =
      !advancedFilters.participants ||
      m.participants.toLowerCase().includes(advancedFilters.participants.toLowerCase());

    const dateFilter =
      !advancedFilters.dateRange ||
      (m.date >= advancedFilters.dateRange.start && m.date <= advancedFilters.dateRange.end);

    // タグフィルター
    const tagFilter =
      !selectedTagFilter || (m.tags && m.tags.includes(selectedTagFilter));

    return basicFilter && searchFilter && statusFilter && participantsFilter && dateFilter && tagFilter;
  });
  const pageTitle =
    page === "calendar"
      ? "共有カレンダー"
      : page === "actions"
        ? "アクション"
        : page === "help"
          ? "使い方ガイド"
          : page === "usage"
            ? "API使用料"
            : page === "stats"
              ? "統計ダッシュボード"
              : page === "compare"
                ? "会議比較"
                : "会議ワークスペース";
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="メニューを閉じる"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside inert={editing} className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <button
          className="brand"
          onClick={() => go("meetings")}
          aria-label="kotonoha ホーム"
        >
          <span className="brand-symbol">
            <AudioLines size={24} />
          </span>
          <span>
            kotonoha<small>会話を、次の一歩に。</small>
          </span>
        </button>
        <div className="workspace-switch">
          <span className="workspace-avatar">K</span>
          <span>
            {isCloud ? "共有ワークスペース" : "マイワークスペース"}
            <small>{isCloud ? "チーム共通" : "パーソナル"}</small>
          </span>
          <span className="local-pill">{isCloud ? "CLOUD" : "LOCAL"}</span>
        </div>
        <button
          className="button primary new-meeting-button"
          onClick={() => {
            setNewOpen(true);
            setSidebarOpen(false);
          }}
        >
          <Plus size={18} />
          新しい会議
        </button>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {(
            [
              { id: "meetings", Icon: LayoutGrid, label: "すべての会議" },
              { id: "calendar", Icon: CalendarDays, label: "カレンダー" },
              { id: "actions", Icon: ListTodo, label: "アクション" },
              { id: "stats", Icon: TrendingUp, label: "統計" },
              { id: "compare", Icon: GitCompare, label: "比較" },
              { id: "usage", Icon: ReceiptText, label: "API使用料" },
              { id: "help", Icon: BookOpen, label: "使い方ガイド" },
            ] as const
          ).map(({ id, Icon, label }) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => go(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "meetings" && (
                <span className="nav-count">{realMeetings.length}</span>
              )}
              {id === "actions" && actionCount > 0 && (
                <span className="nav-count">{actionCount}</span>
              )}
            </button>
          ))}
          <button onClick={() => {
            setSettingsOpen(true);
            setSidebarOpen(false);
          }}>
            <Settings2 size={18} />
            <span>接続設定</span>
            <span className={`status-dot ${settings?.configured ? "" : "off"}`} />
          </button>
        </nav>
        <div className="sidebar-recents">
          <span className="nav-label">最近の会議</span>
          {meetings.slice(0, 5).map((m) => (
            <div key={m.id} className={`recent-row ${selected === m.id ? "selected" : ""}`}>
              <button className="recent-open" onClick={() => openMeeting(m.id)}>
                <FileText size={15} />
                <span>{m.title}</span>
                {isWorking(m) && <span className="status-dot pulse" />}
              </button>
              <button
                className="recent-rename"
                aria-label={`${m.title}の名前を変更`}
                title="名前を変更"
                disabled={isWorking(m)}
                onClick={() => openRename(m)}
              >
                <Pencil size={14} />
              </button>
            </div>
          ))}
          {!meetings.length && (
            <p>
              作成した会議が
              <br />
              ここに表示されます。
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button className="settings-link" onClick={onChooseApp}>アプリ選択に戻る</button>
          <div className="local-info">
            <ShieldCheck size={17} />
            <div>
              <strong>{isCloud ? "専用クラウドに保存" : "このPCに保存"}</strong>
              <small>
                {isCloud ? "全員で同じ記録を共有" : "会議の記録を、手元に。"}
              </small>
            </div>
          </div>
          {isCloud && (
            <button
              className="settings-link"
              onClick={async () => {
                try {
                  if (getSession()?.googleUserId) await signOutGoogleAccount();
                  else await signOut();
                } catch {
                  notify("ログアウトできませんでした。再度お試しください。");
                }
              }}
            >
              ログアウト
            </button>
          )}
          <div className="sidebar-foot">
            <span>kotonoha</span>
            <span>MEETING STUDIO</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar" inert={editing}>
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="メニューを開く"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={21} />
            </button>
            <span>ワークスペース</span>
            <ChevronRight size={13} />
            <strong>{pageTitle}</strong>
          </div>
          <div>
            <span className="topbar-date">
              <CalendarDays size={14} />
              {new Intl.DateTimeFormat("ja-JP", {
                month: "long",
                day: "numeric",
                weekday: "short",
              }).format(new Date())}
            </span>
            <button
              className="icon-button"
              aria-label="使い方を開く"
              onClick={() => go("help")}
            >
              <CircleHelp size={19} />
            </button>
            <span className="profile-avatar">K</span>
          </div>
        </header>
        <main className={`main-content ${current ? "detail-view" : ""}`}>
          {error && (
            <div className="error-message app-error" role="alert">
              {error}
              <button className="text-button" onClick={refresh}>
                再接続
              </button>
            </div>
          )}
          {current ? (
            <MeetingDetail
              key={current.id}
              meeting={current}
              onBack={() => setSelected(null)}
              backLabel={
                page === "calendar" ? "カレンダーへ戻る" : "すべての会議"
              }
              onCalendar={(date) => {
                if (date) setCalendarDate(date);
                go("calendar");
              }}
              onRename={openRename}
              onChooseTags={openAiTags}
              onChange={updateMeeting}
              onDelete={(id) => {
                setMeetings((prev) => prev.filter((m) => m.id !== id));
                setSelected(null);
              }}
              notify={notify}
              onEditingChange={setEditing}
            />
          ) : page === "meetings" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR MEETING, CLEARLY.</div>
                  <h1>会話を、次の一歩に。</h1>
                  <p>録音から議事録まで。会議のあとの仕事を、もっと軽く。</p>
                </div>
                <button
                  className="button secondary"
                  onClick={demo}
                  disabled={demoLoading}
                >
                  {demoLoading ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Sparkles size={16} />
                  )}
                  サンプルを開く
                  <ArrowRight size={15} />
                </button>
              </div>
              <section className="hero-card">
                <div className="hero-content">
                  <div className="hero-tag">
                    <span className="status-dot" />
                    AI MEETING ASSISTANT
                  </div>
                  <h2>
                    話したことを、
                    <br />
                    使える記録に。
                  </h2>
                  <p>
                    録音ファイルをアップロードするだけ。
                    <br />
                    文字起こし、要点の整理、議事録の作成までをひとつに。
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setNewOpen(true)}
                  >
                    <UploadCloud size={18} />
                    録音ファイルを取り込む
                    <ArrowRight size={17} />
                  </button>
                  <span className="hero-formats">
                    AAC・MP3・M4A など対応 · 複数録音を統合
                  </span>
                </div>
                <div className="hero-illustration" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="floating-audio">
                    <span className="audio-icon">
                      <AudioLines size={23} />
                    </span>
                    <div>
                      <b>定例ミーティング.m4a</b>
                      <div className="waveform">
                        {Array.from({ length: 30 }, (_, i) => (
                          <i
                            key={i}
                            style={{
                              height: `${[10, 17, 12, 24, 31, 20, 14, 27, 18, 35, 26, 16][i % 12]}px`,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                    <span className="audio-check">
                      <Check size={13} />
                    </span>
                  </div>
                  <div className="transform-spark">
                    <Sparkles size={22} />
                  </div>
                  <div className="floating-document">
                    <div className="illustration-doc-title">
                      <span>
                        <FileText size={18} />
                      </span>
                      <b>ミーティングの議事録</b>
                      <span className="mini-badge">完成</span>
                    </div>
                    <div className="illustration-line w90" />
                    <div className="illustration-line w65" />
                    <div className="illustration-section">
                      <span>
                        <CheckCheck size={14} />
                        決まったこと
                      </span>
                      <div className="illustration-line w85" />
                      <div className="illustration-line w60" />
                    </div>
                    <div className="illustration-action">
                      <span>
                        <Check size={10} />
                      </span>
                      <div className="illustration-line w65" />
                      <span className="tiny-avatar">K</span>
                    </div>
                  </div>
                  <div className="floating-caption">
                    <Sparkles size={12} />
                    大切なことを、取りこぼさない。
                  </div>
                </div>
              </section>
              <div className="workflow-strip">
                {[
                  {
                    Icon: UploadCloud,
                    title: "録音を取り込む",
                    note: "会議の音声ファイルをアップロード",
                  },
                  {
                    Icon: MessageSquareText,
                    title: "AIが会話を読み解く",
                    note: "全文の文字起こしとポイントの整理",
                  },
                  {
                    Icon: FileText,
                    title: "議事録ができあがる",
                    note: "決定事項・担当・期限までひと目で",
                  },
                ].map(({ Icon, title, note }, i) => (
                  <div className="workflow-step" key={title}>
                    <span className={`step-icon step-${i}`}>
                      <Icon size={20} />
                    </span>
                    <div>
                      <span className="step-number">0{i + 1}</span>
                      <strong>{title}</strong>
                      <small>{note}</small>
                    </div>
                    {i < 2 && <ChevronRight size={16} className="step-arrow" />}
                  </div>
                ))}
              </div>
              <div className="stats-grid">
                <div className="stat-card">
                  <span className="stat-icon purple-bg">
                    <FolderOpen size={20} />
                  </span>
                  <div>
                    <span>保存した会議</span>
                    <strong>
                      {realMeetings.length}
                      <small>件</small>
                    </strong>
                  </div>
                  <span className="stat-note">すべての記録</span>
                </div>
                <div className="stat-card">
                  <span className="stat-icon mint-bg">
                    <CheckCheck size={20} />
                  </span>
                  <div>
                    <span>作成済みの議事録</span>
                    <strong>
                      {realMeetings.filter((m) => m.status === "done").length}
                      <small>件</small>
                    </strong>
                  </div>
                  <span className="stat-note">いつでも振り返る</span>
                </div>
                <div className="stat-card">
                  <span className="stat-icon peach-bg">
                    <ListTodo size={20} />
                  </span>
                  <div>
                    <span>未完了のアクション</span>
                    <strong>
                      {actionCount}
                      <small>件</small>
                    </strong>
                  </div>
                  <button
                    className="stat-link"
                    onClick={() => go("actions")}
                    aria-label="アクションを確認"
                  >
                    <ArrowRight size={17} />
                  </button>
                </div>
              </div>
              <section className="meetings-section">
                <div className="section-heading">
                  <h2>
                    会議ライブラリ<span>{meetings.length}</span>
                  </h2>
                  <div className="search-filters-row">
                    <label className="search-box">
                      <Search size={16} />
                      <input
                        aria-label="会議を検索"
                        placeholder="会議名や内容で検索…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      {search && (
                        <button
                          className="icon-button"
                          aria-label="検索をクリア"
                          onClick={() => setSearch("")}
                        >
                          <X size={13} />
                        </button>
                      )}
                    </label>
                    <button
                      className={`icon-button ${showSearchOptions ? "active" : ""}`}
                      aria-label="検索オプション"
                      onClick={() => setShowSearchOptions(!showSearchOptions)}
                    >
                      <Settings2 size={16} />
                    </button>
                    <button
                      className={`icon-button ${showAdvancedFilters ? "active" : ""}`}
                      aria-label="高度なフィルター"
                      onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
                    >
                      <Filter size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="一括エクスポート"
                      onClick={() => setShowExportDialog(true)}
                    >
                      <ArrowDownToLine size={16} />
                    </button>
                  </div>
                </div>
                {showSearchOptions && (
                  <div className="search-options-panel">
                    <div className="filter-row">
                      <label>検索対象</label>
                      <div className="checkbox-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={searchOptions.searchIn.title}
                            onChange={(e) =>
                              setSearchOptions({
                                ...searchOptions,
                                searchIn: { ...searchOptions.searchIn, title: e.target.checked },
                              })
                            }
                          />
                          会議名
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={searchOptions.searchIn.transcript}
                            onChange={(e) =>
                              setSearchOptions({
                                ...searchOptions,
                                searchIn: { ...searchOptions.searchIn, transcript: e.target.checked },
                              })
                            }
                          />
                          文字起こし
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={searchOptions.searchIn.minutes}
                            onChange={(e) =>
                              setSearchOptions({
                                ...searchOptions,
                                searchIn: { ...searchOptions.searchIn, minutes: e.target.checked },
                              })
                            }
                          />
                          議事録
                        </label>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={searchOptions.searchIn.actions}
                            onChange={(e) =>
                              setSearchOptions({
                                ...searchOptions,
                                searchIn: { ...searchOptions.searchIn, actions: e.target.checked },
                              })
                            }
                          />
                          アクション
                        </label>
                      </div>
                    </div>
                    <div className="filter-row">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={searchOptions.caseSensitive}
                          onChange={(e) =>
                            setSearchOptions({ ...searchOptions, caseSensitive: e.target.checked })
                          }
                        />
                        大文字・小文字を区別
                      </label>
                    </div>
                  </div>
                )}
                {showAdvancedFilters && (
                  <div className="advanced-filters-panel">
                    <div className="filter-row">
                      <label>
                        日付範囲
                        <div className="date-range-inputs">
                          <input
                            type="date"
                            value={advancedFilters.dateRange?.start || ""}
                            onChange={(e) =>
                              setAdvancedFilters((prev) => ({
                                ...prev,
                                dateRange: {
                                  start: e.target.value,
                                  end: prev.dateRange?.end || today(),
                                },
                              }))
                            }
                          />
                          <span>〜</span>
                          <input
                            type="date"
                            value={advancedFilters.dateRange?.end || ""}
                            onChange={(e) =>
                              setAdvancedFilters((prev) => ({
                                ...prev,
                                dateRange: {
                                  start: prev.dateRange?.start || today(),
                                  end: e.target.value,
                                },
                              }))
                            }
                          />
                        </div>
                      </label>
                    </div>
                    <div className="filter-row">
                      <label>
                        参加者
                        <input
                          type="text"
                          placeholder="参加者名で絞り込み…"
                          value={advancedFilters.participants}
                          onChange={(e) =>
                            setAdvancedFilters((prev) => ({
                              ...prev,
                              participants: e.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <div className="filter-row">
                      <label>
                        ステータス
                        <select
                          value={advancedFilters.status}
                          onChange={(e) =>
                            setAdvancedFilters((prev) => ({
                              ...prev,
                              status: e.target.value as MeetingFilters["status"],
                            }))
                          }
                        >
                          <option value="all">すべて</option>
                          <option value="done">作成完了</option>
                          <option value="working">処理中</option>
                          <option value="error">エラー</option>
                        </select>
                      </label>
                    </div>
                    <div className="filter-row">
                      <label>
                        タグで絞り込み
                        <div className="tag-filter-row">
                          <button
                            className={`tag-filter-btn ${!selectedTagFilter ? "active" : ""}`}
                            onClick={() => setSelectedTagFilter(null)}
                          >
                            すべて
                          </button>
                          {tags.map((tag) => (
                            <button
                              key={tag.id}
                              className={`tag-filter-btn ${selectedTagFilter === tag.id ? "active" : ""}`}
                              style={{ 
                                borderColor: selectedTagFilter === tag.id ? tag.color : "#e9eaf1",
                                backgroundColor: selectedTagFilter === tag.id ? `${tag.color}20` : "transparent"
                              }}
                              onClick={() => setSelectedTagFilter(tag.id)}
                            >
                              <span
                                className="tag-color-dot"
                                style={{ backgroundColor: tag.color }}
                              />
                              {tag.name}
                            </button>
                          ))}
                          <button
                            className="tag-filter-btn tag-manager-btn"
                            onClick={() => setShowTagManager(!showTagManager)}
                          >
                            <TagIcon size={14} />
                            タグ管理
                          </button>
                        </div>
                      </label>
                    </div>
                    {showTagManager && (
                      <div className="tag-manager-panel">
                        <div className="tag-create-row">
                          <input
                            type="text"
                            placeholder="新しいタグ名…"
                            value={newTagName}
                            onChange={(e) => setNewTagName(e.target.value)}
                          />
                          <button
                            className="button primary"
                            onClick={createTag}
                            disabled={!newTagName.trim()}
                          >
                            追加
                          </button>
                        </div>
                        <div className="tag-list">
                          {tags.map((tag) => (
                            <div key={tag.id} className="tag-item">
                              <span
                                className="tag-color-dot"
                                style={{ backgroundColor: tag.color }}
                              />
                              <span>{tag.name}</span>
                              <button
                                className="icon-button"
                                onClick={() => deleteTag(tag.id)}
                                disabled={meetings.some((m) => m.tags?.includes(tag.id))}
                                title="使用中のタグは各会議から外してください"
                                aria-label={`${tag.name}の候補を削除`}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                          {tags.length === 0 && (
                            <p className="muted">タグがありません。新しいタグを作成してください。</p>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="filter-actions">
                      <button
                        className="button secondary"
                        onClick={() =>
                          setAdvancedFilters({
                            dateRange: null,
                            participants: "",
                            status: "all",
                          })
                        }
                      >
                        フィルターをクリア
                      </button>
                    </div>
                  </div>
                )}
                {tagAssignmentTarget && (
                  <div className="tag-assignment-modal">
                    <div className="tag-assignment-content">
                      <div className="tag-assignment-header">
                        <h3>タグを追加</h3>
                        <button
                          className="icon-button"
                          onClick={() => setTagAssignmentTarget(null)}
                        >
                          <X size={18} />
                        </button>
                      </div>
                      <div className="tag-assignment-list">
                        {tags.map((tag) => {
                          const meeting = meetings.find((m) => m.id === tagAssignmentTarget);
                          const isAssigned = meeting?.tags?.includes(tag.id);
                          return (
                            <button
                              key={tag.id}
                              className={`tag-assignment-item ${isAssigned ? "assigned" : ""}`}
                              onClick={() => toggleMeetingTag(tagAssignmentTarget, tag.id)}
                              disabled={tagBusy || !!meeting && (isWorking(meeting) || meeting.status === "uploading")}
                            >
                              <span
                                className="tag-color-dot"
                                style={{ backgroundColor: tag.color }}
                              />
                              {tag.name}
                              {isAssigned && <Check size={14} />}
                            </button>
                          );
                        })}
                        {tags.length === 0 && (
                          <p className="muted">タグがありません。タグ管理から作成してください。</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {showExportDialog && (
                  <div className="export-dialog">
                    <div className="export-content">
                      <div className="export-header">
                        <h3>一括エクスポート</h3>
                        <button
                          className="icon-button"
                          onClick={() => setShowExportDialog(false)}
                        >
                          <X size={18} />
                        </button>
                      </div>
                      <p className="muted">現在表示中の {filtered.length} 件の会議をエクスポートします。</p>
                      <div className="export-options">
                        <button
                          className="export-option"
                          onClick={() => handleExport("markdown")}
                        >
                          <FileText size={24} />
                          <div>
                            <strong>Markdown</strong>
                            <small>ドキュメント形式</small>
                          </div>
                        </button>
                        <button
                          className="export-option"
                          onClick={() => handleExport("json")}
                        >
                          <ReceiptText size={24} />
                          <div>
                            <strong>JSON</strong>
                            <small>データ形式</small>
                          </div>
                        </button>
                        <button
                          className="export-option"
                          onClick={() => handleExport("ics")}
                        >
                          <CalendarDays size={24} />
                          <div>
                            <strong>iCal (.ics)</strong>
                            <small>カレンダー形式</small>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="library-tabs">
                  {[
                    ["all", "すべて"],
                    ["done", "作成完了"],
                    ["processing", "処理中"],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      className={filter === id ? "active" : ""}
                      onClick={() => setFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                  <span>新しい順</span>
                </div>
                {loading ? (
                  <div className="empty-state">
                    <LoaderCircle className="spin" size={25} />
                    <p>会議を読み込んでいます…</p>
                  </div>
                ) : filtered.length ? (
                  <div className="meeting-list">
                    {filtered.map((m) => (
                      <div
                        className="meeting-row"
                        key={m.id}
                        onClick={() => openMeeting(m.id)}
                      >
                        <span
                          className={`meeting-file-icon ${m.isDemo ? "demo" : ""}`}
                        >
                          {m.source === "audio" ? (
                            <FileAudio size={23} />
                          ) : (
                            <FileText size={23} />
                          )}
                        </span>
                        <div className="meeting-row-info">
                          <button className="meeting-open" onClick={(event) => {
                            event.stopPropagation();
                            openMeeting(m.id);
                          }}>
                            <strong>{m.title}</strong>
                          </button>
                          <span>
                            <span>{formatDate(m.date)}</span>
                            <i aria-hidden="true" />
                            <span className="meeting-participants">{m.participants || "参加者未記入"}</span>
                            <span className="meeting-duration">
                              <Clock3 size={14} aria-hidden="true" />
                              録音 {formatDuration(m.duration)}
                            </span>
                            {m.isDemo && <em>サンプル</em>}
                          </span>
                          {m.tags && m.tags.length > 0 && (
                            <div className="meeting-tags">
                              {m.tags.map((tagId) => {
                                const tag = tags.find((t) => t.id === tagId);
                                return tag ? (
                                  <span
                                    key={tagId}
                                    className="meeting-tag"
                                    style={{ backgroundColor: `${tag.color}20`, borderColor: tag.color }}
                                  >
                                    <span
                                      className="tag-color-dot"
                                      style={{ backgroundColor: tag.color }}
                                    />
                                    {tag.name}
                                  </span>
                                ) : null;
                              })}
                            </div>
                          )}
                          <button
                            className="tag-assign-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTagAssignmentTarget(m.id);
                            }}
                            title="タグを追加"
                          >
                            <TagIcon size={14} />
                          </button>
                        </div>
                        <span
                          className={`badge ${m.status === "done" ? "success" : m.status === "error" ? "failure" : "neutral"}`}
                        >
                          {m.status === "done" ? (
                            <Check size={12} />
                          ) : isWorking(m) ? (
                            <LoaderCircle className="spin" size={12} />
                          ) : null}
                          {m.status === "done"
                            ? "作成完了"
                            : m.status === "transcribing"
                              ? m.transcriptionWait
                                ? "自動再開待ち"
                                : "文字起こし中"
                              : m.status === "analyzing"
                                ? "解析中"
                                : m.status === "uploading"
                                  ? m.bot
                                    ? "Botアップロード中"
                                    : "取り込み途中"
                                  : m.status === "bot"
                                    ? botPhase(m) === "error"
                                      ? "Botエラー"
                                      : `Bot${BOT_PHASE_LABELS[botPhase(m) as keyof typeof BOT_PHASE_LABELS]}`
                                    : "要確認"}
                        </span>
                        <ChevronRight size={17} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <span className="empty-state-icon">
                      <FolderOpen size={30} />
                    </span>
                    <h3>
                      {search || filter !== "all"
                        ? "条件に一致する会議がありません"
                        : "最初の会議を、ここから。"}
                    </h3>
                    <p>
                      {search || filter !== "all"
                        ? "検索キーワードや絞り込みを変更してください。"
                        : "録音を取り込むと、会議の記録がここに集まります。"}
                    </p>
                    {!search && filter === "all" && (
                      <button
                        className="text-button purple"
                        onClick={demo}
                        disabled={demoLoading}
                      >
                        まずはサンプルを見てみる
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                )}
              </section>
              <div className="page-footer">
                <span>
                  <ShieldCheck size={14} />
                  {isCloud
                    ? `記録は専用クラウドで共有。音声は${transcriptionModelName(settings?.transcriptionModel)}で文字起こし。`
                    : `記録はこのPCに保存。音声は${transcriptionModelName(settings?.transcriptionModel)}で文字起こし。`}
                </span>
                <button
                  className="text-button"
                  onClick={() => setSettingsOpen(true)}
                >
                  {settings?.configured
                    ? `${transcriptionModelName(settings.transcriptionModel)} → ${modelName(settings.model)}`
                    : "AIの接続設定をする"}
                  <ArrowRight size={13} />
                </button>
              </div>
            </>
          ) : page === "calendar" ? (
            <Calendar
              meetings={meetings}
              selectedDate={calendarDate}
              onSelectDate={setCalendarDate}
              onOpenMeeting={openMeeting}
              onNew={() => setNewOpen(true)}
              onChange={updateMeeting}
              onEditingChange={setEditing}
              notify={notify}
            />
          ) : page === "actions" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">FROM WORDS TO ACTION.</div>
                  <h1>次の一歩を、ひとつずつ。</h1>
                  <p>会議から生まれたアクションを、まとめて確認できます。</p>
                </div>
                <span className="badge neutral">
                  未完了 {actionCount} 件（サンプルを除く）
                </span>
              </div>
              {meetings.filter((m) => m.minutes?.actions.length).length ? (
                meetings
                  .filter((m) => m.minutes?.actions.length)
                  .map((m) => (
                    <section className="actions-group" key={m.id}>
                      <div className="section-heading">
                        <button
                          className="text-button"
                          onClick={() => openMeeting(m.id)}
                        >
                          <FileText size={17} />
                          {m.title}
                          <ArrowRight size={14} />
                        </button>
                        {m.isDemo && (
                          <span className="badge sample">サンプル</span>
                        )}
                      </div>
                      <ActionList
                        meeting={m}
                        onChange={updateMeeting}
                        notify={notify}
                      />
                    </section>
                  ))
              ) : (
                <div className="empty-state standalone">
                  <ListTodo size={36} />
                  <h3>まだアクションはありません</h3>
                  <p>
                    会議の解析が完了すると、担当者と期限をここで確認できます。
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setNewOpen(true)}
                  >
                    <Plus size={16} />
                    会議を作成
                  </button>
                </div>
              )}
            </>
          ) : page === "usage" ? (
            <UsagePage meetings={meetings} />
          ) : page === "stats" ? (
            <StatsPage meetings={meetings} />
          ) : page === "compare" ? (
            <ComparePage meetings={meetings} />
          ) : (
            <Help
              onNew={() => setNewOpen(true)}
              onSettings={() => setSettingsOpen(true)}
            />
          )}
        </main>
      </div>
      {aiTagTarget && aiTagMeeting && !editing && !newOpen && !settingsOpen && !renameTarget && !tagAssignmentTarget && !showTagManager && !showExportDialog && (
        <TagSuggestionDialog
          key={aiTagTarget.key}
          meeting={aiTagMeeting}
          load={loadAiTags}
          save={saveAiTags}
          onClose={() => setAiTagQueue(previous => previous.filter(item => item.key !== aiTagTarget.key))}
        />
      )}
      {newOpen && (
        <NewMeeting
          settings={settings}
          onClose={() => setNewOpen(false)}
          onCreate={create}
          onBot={requestBot}
          onSettings={() => setSettingsOpen(true)}
          templates={templates}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSave={(value) => {
            setSettings(value);
            setSettingsOpen(false);
            notify("AIの接続設定を保存しました");
          }}
          onRequestNotification={requestNotificationPermission}
          notificationPermission={notificationPermission}
        />
      )}
      {renameTarget && (
        <Modal
          title="会議名を変更"
          subtitle="一覧・会議詳細・書き出し時の名前に反映されます。"
          onClose={() => setRenameTarget(null)}
          locked={renameBusy}
        >
          <form onSubmit={saveRename}>
            <label className="field">
              会議名
              <input
                ref={renameInput}
                required
                maxLength={160}
                value={renameDraft}
                onChange={(event) => {
                  setRenameDraft(event.target.value);
                  setRenameError("");
                }}
              />
            </label>
            {renameError && <p className="error-message" role="alert">{renameError}</p>}
            <div className="modal-footer">
              <button type="button" className="button secondary" disabled={renameBusy} onClick={() => setRenameTarget(null)}>キャンセル</button>
              <button type="submit" className="button primary" disabled={renameBusy || !renameDraft.trim()}>保存する</button>
            </div>
          </form>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="通知を閉じる"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function Help({
  onNew,
  onSettings,
}: {
  onNew: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="help-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A LITTLE GUIDE.</div>
          <h1>録音から、使える議事録へ。</h1>
          <p>準備は録音ファイルだけ。あとの整理はAIに任せましょう。</p>
        </div>
      </div>
      <div className="help-steps">
        {[
          {
            title: "AIの接続設定",
            text: "OpenAIのAPIキーを設定し、議事録に使うGPT-6 Astra・Sol・Lunaを選択します。文字起こしはGPT TranscribeまたはGemini 3.5 Transcribeから選べます。Geminiを使う場合はGemini APIキーも設定してください。",
            action: "接続設定を開く",
            run: onSettings,
          },
          {
            title: "録音済みファイルを取り込む",
            text: "音声はAAC・MP3・M4A・WAV・OGG・FLAC、動画はMP4・MOV・MKV・WebM・MTS・TS・3GPに対応（動画は音声だけを使い、Dolbyなどの音声はブラウザー内で変換）。最大5ファイル・合計100 MB（100,000,000バイト）まで選び、上下ボタンで録音順に並べます。大きな録音はブラウザー内で自動分割し、順番に文字起こしして1つの議事録にまとめます。送信完了まで画面を開いたままにしてください。その後は、画面を閉じても完了分が保存され、次回開くと未処理分を再開します。録音は文字起こしタブで分割ごとに再生できます。文字起こしは合計10万文字までです。",
            action: "録音を取り込む",
            run: onNew,
          },
          {
            title: "文字起こしから議事録まで自動作成",
            text: `新しい会議では形式の選択は不要です。要約・標準・詳細をまとめて作成し、最初に標準版を表示します。作成後はタブで切り替えられます。録音を全文テキストに変換した後、議題・決定事項・アクション・継続検討事項を整理します。Geminiは送信間隔を30秒以上空け、一時的な利用制限（429）では待ち時間を延ばして最大5回自動で再試行します。待機時間と完了数は会議の詳細に表示されます。日次上限などはGoogle AI Studioで利用枠をご確認ください。${isCloud ? "完了分と待機時刻は保存され、画面を閉じてもサーバーの定期処理が未処理分から自動で再開します。" : "処理中はアプリのサーバーを起動したままにしてください。"}`,
          },
          {
            title: "API使用料を確認",
            text: "左メニューの「API使用料」で対象月のドル円レートを入力・保存すると、解析1回ごとの概算料金を円で確認できます。解析の内訳には文字起こし・議事録生成の日時、モデル、入力・出力トークン、音声時間を表示します。分割録音は同じ解析にまとめ、再生成は別の解析です。レートはこのブラウザーに月ごとに保存されます。旧履歴のまとめ方は推定で、料金は請求の確定額ではありません。",
          },
          {
            title: "会議資料を添付して保管",
            text: "新しい会議で「参加者・添付資料など」を開き、「会議の添付資料」からExcel・Word・PDF・PowerPoint・CSV・TXTを追加できます。資料は録音とは別枠で最大5ファイル・各10 MB・合計25 MB。既存会議では「添付資料」タブから追加できます。資料は会議の参考資料として保存するだけで、AIには送信せず、議事録の解析にも使いません。保存した資料は「添付資料」タブからいつでもダウンロードできます。",
          },
          {
            title: "カレンダーで予定・期限を確認、手動で変更",
            text: "会話で決まった予定や期限を月間・一覧で確認できます。日本時間で表示し、予定案・資料のみの記載は確定と区別します。日付を特定できない「来週まで」などは日付要確認に置きます。以前の議事録の日付は要確認の候補として表示します。「予定を編集」で内容を変更できます。カードの「削除」で1件を除外し、「選択して一括削除」では複数件を選べます。日付未定欄の「このN件を選択」でまとめて選べます。削除済みの予定は下部から戻せます。元の会議録は消えず、変更は全員に共有されます。同じ予定の削除は再解析後も保持しますが、AIが別の内容として抽出した予定は新しい候補として現れる場合があります。外部カレンダーへの自動同期はありません。通知の条件は下の「集計・タグ・通知について」をご確認ください。",
          },
          {
            title: "内容を確認して、編集・書き出し",
            text: "会議名は詳細タイトル横の「名前を変更」、または左メニュー「最近の会議」の鉛筆ボタンから変更できます。議事録タブの「議事録を編集」から本文を自由に修正し、「保存」で全員に共有できます。本文・カレンダー・AI抽出の要点やアクションは別々に管理され、本文の修正は他の欄に自動反映しません。同じ本文を同時に編集した場合は最後の保存が優先されます。「文字起こし」で音声を再生しながら確認・修正し、議事録を再生成することもできます。再生成は編集済み本文を上書きするため確認してください。「書き出す」からMarkdown・テキスト・JSONを保存でき、印刷からPDFにもできます。",
          },
        ].map((step, i) => (
          <section key={step.title}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <div>
              <h2>{step.title}</h2>
              <p>{step.text}</p>
              {step.run && (
                <button className="text-button purple" onClick={step.run}>
                  {step.action}
                  <ArrowRight size={14} />
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
      <section className="help-note">
        <ShieldCheck size={23} />
        <div>
          <h3>データの保存について</h3>
          <p>
            {isCloud
              ? "会議・音声・資料はSupabaseの会議録専用領域に非公開で保存し、ログインした全員で共有します。追加・編集・削除も共通です。他の人の変更は約10秒ごとに反映します（編集中を除く）。OpenAIとGeminiのAPIキーはワークスペース共通で別々に暗号化保存し、画面には再表示しません。Gemini文字起こしを選ぶと音声をGoogleへ送信し、文字起こし後に一時ファイルの削除を要求します。Geminiで完了しなかった録音はGPT Transcribeに自動で切り替え、その録音の音声はOpenAIへ送信します。テキスト・議事録生成はOpenAIへ送信されます。添付資料はAIへ送信しません。会議の削除・資料の関連付け解除後も資料は保持します。復元・完全消去は管理者にご依頼ください。"
              : "会議・音声・資料はアプリの .data フォルダに保存されます。Dropboxの設定によってはクラウドにも同期されます。Gemini文字起こしを選ぶと音声をGoogleへ送信し（完了しなかった録音はGPT Transcribeに自動で切り替えてOpenAIへ送信）、テキスト・議事録生成はOpenAIへ送信します。添付資料はAIへ送信しません。関連付けを解除した資料も保持します。削除した会議は .data/trash に移動します。"}
          </p>
        </div>
      </section>
      <section className="help-note">
        <MessageSquareText size={23} />
        <div>
          <h3>集計・タグ・通知について</h3>
          <p>API使用料は、文字起こし・議事録生成・タグ候補生成までを同じ解析ブロックに合算します。再解析は別ブロックです。既存のタグ履歴の紐付けは会議と処理順から推定し、元の料金と月合計は変更しません。</p>
          <p>要約版／標準版／詳細版（背景も詳しく）を1回のAI応答でまとめて作成・保存し、「議事録」内のタブで切り替えます。切り替えだけなら追加AI課金はありません。会議内容に応じて項目と分量を調整し、ページ数は固定しません。本文編集・コピー・Markdown／PDF出力は表示中の形式が対象です。以前の単一形式の会議は「3形式を作成」から再生成できます（AI使用料がかかります）。保存済みの文字起こしを再利用し、未完了の音声のみ文字起こしを行います。再生成すると3形式すべての編集済み本文とアクションの完了状態が上書きされます。既存タグと予定の手動変更は保持します。キャンセル時は変更しません。</p>
          <p>
            時間比較・総録音時間は分割音声の時間を合計します。時間が不明な会議は「未取得」と表示し、平均・合計から除外します。既存の会議も再解析せず反映されます。
          </p>
          <p>
            AIサマリーは「今月」「先月」「直近7日」「期間指定」から選べます。先月は前月1日〜末日、期間指定は開始日と終了日を含む範囲です。日本時間の今日までに開催した解析完了の会議が対象です。見出し・段落・箇条書きで整理し、タグ提案とともにAPI使用料に記録します。サマリーは画面内だけの表示です。
          </p>
          <p>
            アプリを開いている間に議事録が完成すると、AIタグ候補をポップアップで自動表示します。必要な候補にチェックし、「選んだタグを保存」を押すと、その議事録に紐付けて全員に共有します。既存タグは残ります。選ぶだけ・閉じるだけでは保存しません。複数会議は順番に表示します。候補の取得に失敗しても議事録は利用でき、再取得は手動です。閉じた候補や過去の会議は、詳細の「タグ候補を開く」から選べます。同じ画面内では候補を再利用し、再読み込み後は再生成になります。画面を閉じている間に完了した会議の候補は手動で開いてください。手動作成した未使用のタグ名だけはこのブラウザーに保存します。
          </p>
          <p>
            会議比較は2〜5件を選べます。一括Markdownには保存済み本文を含み、ICSは会議の開催日を終日予定として書き出します。通知を許可すると、アプリを開いている間だけ確定した期限の超過を同じタブで1回通知します。アプリを閉じている間の通知・外部カレンダーへの自動同期はありません。
          </p>
        </div>
      </section>
      <section className="help-note">
        <MessageSquareText size={23} />
        <div>
          <h3>解析結果について</h3>
          <p>
            GPT-4o
            Transcribeの文字起こしには話者名・発言時刻が含まれません。参加者名との対応は推測せず、会話にない担当者や期限は「未定」として扱います。決定事項や固有名詞は元の録音と照合してください。
          </p>
        </div>
      </section>
    </div>
  );
}
