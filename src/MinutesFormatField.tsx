import {
  MINUTES_FORMATS,
  minutesFormat,
} from "../supabase/functions/_shared/minutes-formats.mjs";
import type { Meeting } from "./types";

export function MinutesFormatField({
  value,
  onChange,
  disabled = false,
}: {
  value: Meeting["template"];
  onChange: (value: Meeting["template"]) => void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      議事録の形式・詳しさ
      <select
        value={value}
        onChange={(event) =>
          onChange(event.target.value as Meeting["template"])
        }
        disabled={disabled}
      >
        {MINUTES_FORMATS.map((format) => (
          <option key={format.id} value={format.id}>
            {format.label}
          </option>
        ))}
      </select>
      <small>{minutesFormat(value).description}</small>
      <small>
        会議内容に応じて項目と分量を調整します。ページ数は固定せず、会話にない内容は補いません。
      </small>
    </label>
  );
}
