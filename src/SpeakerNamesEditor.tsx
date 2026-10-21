import { useState } from "react";
import { Save, UserPen, X } from "lucide-react";
import { cleanSpeakerNames, transcriptSpeakers } from "./speaker-names.mjs";

// Rename 話者0, 話者1, … once and every line, the minutes, the PDF and the
// downloads show the name. Numbers restart in each recording, so each
// recording's speakers are named separately.
export function SpeakerNamesEditor({
  transcript,
  names,
  disabled,
  onSave,
}: {
  transcript: string;
  names: Record<string, string>;
  disabled: boolean;
  onSave: (names: Record<string, string>) => Promise<void>;
}) {
  const speakers = transcriptSpeakers(transcript);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  if (!speakers.length) return null;
  const recordings = new Set(speakers.map((s) => s.recording)).size;
  const cleaned = cleanSpeakerNames(draft);
  const changed = JSON.stringify(cleaned) !== JSON.stringify(cleanSpeakerNames(names));
  if (!open)
    return (
      <div className="speaker-names-bar">
        <button
          className="button secondary small"
          onClick={() => {
            setDraft({ ...names });
            setOpen(true);
          }}
          disabled={disabled}
        >
          <UserPen size={14} />
          話者名を変更
        </button>
        <span>「話者0」などを名前に置き換えて、文字起こし・議事録・PDFにまとめて反映します。</span>
      </div>
    );
  return (
    <form
      className="speaker-names-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          await onSave(cleaned);
          setOpen(false);
        } catch {
          // The error is shown by onSave; keep the form open with the input.
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="speaker-names-help">
        名前を入れた話者は、すべての発言と議事録の「話者0（録音1）」などが、その名前で表示されます。空欄にすると番号の表示に戻ります。
        {recordings > 1 && "話者番号は録音ごとに振り直されるため、録音ごとに入力してください。"}
      </p>
      <div className="speaker-names-grid">
        {speakers.map((s) => (
          <label key={s.key} className="speaker-name-row">
            <span>
              {recordings > 1 && <small>録音{s.recording}</small>}
              {s.speaker}
              <small>{s.turns}回の発言</small>
            </span>
            <input
              value={draft[s.key] ?? ""}
              maxLength={100}
              placeholder="名前（例：佐藤）"
              onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
              disabled={saving}
            />
          </label>
        ))}
      </div>
      <div className="speaker-names-actions">
        <button
          type="button"
          className="button ghost small"
          onClick={() => {
            if (!changed || window.confirm("保存していない話者名の変更を破棄しますか？")) setOpen(false);
          }}
          disabled={saving}
        >
          <X size={14} />
          取消
        </button>
        <button type="submit" className="button primary small" disabled={saving || disabled || !changed}>
          <Save size={14} />
          {saving ? "保存中…" : "まとめて保存"}
        </button>
      </div>
    </form>
  );
}
