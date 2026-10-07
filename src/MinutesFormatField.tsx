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
      最初に表示する形式
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
        要約・標準・詳細の3形式をまとめて作成します。作成後はタブで切り替えられます。切り替え時の追加AI課金はありません。
      </small>
    </label>
  );
}
