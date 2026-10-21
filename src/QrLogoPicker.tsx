import { useId } from "react";
import { QR_LOGOS } from "../supabase/functions/_shared/qr-logos.mjs";

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
  const selected = QR_LOGOS.find((logo) => logo.id === value);
  const unavailable = value !== null && !selected;
  const assetUrl = (file: string) =>
    `${import.meta.env.BASE_URL.replace(/\/$/, "")}/qr-logos/${file}`;
  const groups = [
    { kind: "store", label: "店舗ロゴ" },
    { kind: "sns", label: "SNSロゴ" },
  ];
  return (
    <fieldset className="qr-logo-picker" disabled={disabled}>
      <legend>{label}</legend>
      {unavailable && (
        <p role="alert" className="qr-error">
          この画面では未対応のロゴです。設定は保持しています。別のロゴを選ぶか、入力・送信の結果を確認してから画面を再読み込みしてください。
        </p>
      )}
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
          <span>
            {selected?.label ||
              (unavailable ? "未対応のロゴ（設定を保持）" : "ロゴなし")}
          </span>
          <small>ロゴを選ぶ・外す</small>
        </summary>
        <div className="qr-logo-categories">
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
            {unavailable && (
              <label className="qr-logo-option selected">
                <input
                  type="radio"
                  name={name}
                  value={value ?? ""}
                  checked
                  disabled
                  readOnly
                />
                <span className="qr-logo-none" aria-hidden="true">
                  ?
                </span>
                <span>未対応のロゴ（保持中）</span>
              </label>
            )}
          </div>
          {groups.map((group) => {
            const choices = QR_LOGOS.filter((logo) => logo.kind === group.kind);
            return (
              <section
                key={group.kind}
                className="qr-logo-group"
                role="group"
                aria-label={group.label}
              >
                <h4 className="qr-logo-group-title">
                  {group.label}
                  <small>{choices.length}種類</small>
                </h4>
                <div className="qr-logo-options">
                  {choices.map((logo) => (
                    <label
                      key={logo.id}
                      className={`qr-logo-option ${logo.kind === "store" ? "qr-logo-option-store" : ""} ${value === logo.id ? "selected" : ""}`}
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
                        style={{
                          backgroundColor: `rgb(${logo.background.join(",")})`,
                        }}
                      />
                      <span>{logo.label}</span>
                    </label>
                  ))}
                </div>
              </section>
            );
          })}
          <p className="qr-logo-hint">
            店舗ロゴは縦横比を保ち、QRの安全余力を残してサイズを自動調整します。印刷・配布前に実際の端末でご確認ください。
          </p>
        </div>
      </details>
    </fieldset>
  );
}
