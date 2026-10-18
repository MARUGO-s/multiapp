import { useId } from "react";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";
import {
  QR_STORE_NAME_MAX_LENGTH,
  validateStoreName,
} from "../supabase/functions/_shared/qr-store-name.mjs";

export function QrStoreNameField({
  logoId,
  value,
  onChange,
  disabled = false,
  label = "QRの下に表示する店舗名",
}: {
  logoId: string | null;
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const logo = QR_LOGOS.find((item) => item.id === logoId);
  if (logo?.kind !== "store") return null;
  let error = "";
  try {
    validateStoreName(value);
  } catch {
    error = `店舗名は${QR_STORE_NAME_MAX_LENGTH}文字以内で入力してください。改行・制御文字は使えません。`;
  }
  return (
    <div className="qr-store-name-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value ?? logo.label}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
        ref={(element) => {
          element?.setCustomValidity(error);
        }}
        onChange={(event) => {
          if (!disabled) onChange(event.target.value);
        }}
      />
      <p id={`${id}-help`} className="qr-analysis-meta">
        {QR_STORE_NAME_MAX_LENGTH}
        文字まで。空欄で非表示。QRの余白の外に表示し、保存した店舗名をPNGにも使います。管理用の名前は変わりません。
      </p>
      {error && (
        <p id={`${id}-error`} className="error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
