import { useId } from "react";
import {
  QR_LOGOS,
  findQrLogo,
} from "../supabase/functions/_shared/qr-logos.mjs";

export function QrLogoPicker({
  value,
  onChange,
  disabled = false,
  label = "QRのロゴ",
}: {
  value: string | null;
  onChange: (logoId: string | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const name = useId();
  const selected = findQrLogo(value);
  const assetUrl = (file: string) =>
    `${import.meta.env.BASE_URL.replace(/\/$/, "")}/qr-logos/${file}`;
  return (
    <fieldset className="qr-logo-picker" disabled={disabled}>
      <legend>{label}</legend>
      <details>
        <summary>
          {selected && (
            <img
              src={assetUrl(selected.file)}
              alt=""
              style={{
                backgroundColor: `rgb(${selected.background.join(",")})`,
              }}
            />
          )}
          <span>{selected?.label || "ロゴなし"}</span>
          <small>ロゴを選ぶ・外す</small>
        </summary>
        <div className="qr-logo-options">
          <label
            className={`qr-logo-option ${value === null ? "selected" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value=""
              checked={value === null}
              onChange={() => {
                if (!disabled) onChange(null);
              }}
            />
            <span className="qr-logo-none" aria-hidden="true">
              —
            </span>
            <span>ロゴなし</span>
          </label>
          {QR_LOGOS.map((logo) => (
            <label
              key={logo.id}
              className={`qr-logo-option ${value === logo.id ? "selected" : ""}`}
            >
              <input
                type="radio"
                name={name}
                value={logo.id}
                checked={value === logo.id}
                onChange={() => {
                  if (!disabled) onChange(logo.id);
                }}
              />
              <img
                src={assetUrl(logo.file)}
                alt=""
                loading="lazy"
                style={{ backgroundColor: `rgb(${logo.background.join(",")})` }}
              />
              <span>{logo.label}</span>
            </label>
          ))}
        </div>
      </details>
    </fieldset>
  );
}
