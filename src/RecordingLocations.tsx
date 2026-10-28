import { useState } from "react";
import { api } from "./api";
import { isWorking, type Meeting } from "./types";
import { RecordingLocationSchema } from "../supabase/functions/_shared/recording-location.mjs";
import "./recording-location.css";

export function RecordingLocations({
  meeting,
  onChange,
  notify,
}: {
  meeting: Meeting;
  onChange: (meeting: Meeting) => void;
  notify: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const points = (meeting.recordingLocations || []).filter(
    ({ sourceIndex, ...point }) =>
      Number.isInteger(sourceIndex) &&
      sourceIndex >= 0 &&
      RecordingLocationSchema.safeParse(point).success,
  );
  if (!points.length) return null;
  async function remove() {
    if (
      !window.confirm("この会議の録音場所をすべて削除します。元に戻せません。")
    )
      return;
    setSaving(true);
    try {
      onChange(
        await api<Meeting>(`/meetings/${meeting.id}`, {
          method: "PATCH",
          body: JSON.stringify({ recordingLocations: null }),
        }),
      );
      notify("録音場所を削除しました。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "削除できませんでした。");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="recording-locations" aria-label="録音場所">
      <strong>録音開始時の場所</strong>
      <p className="field-hint">
        会議を閲覧できる人に共有されています。PDF・書き出し・AIには自動で含めません。住所は自動取得しません。地図を開くと位置が地図サービスに送られます。
      </p>
      {points.map((point) => (
        <div key={point.sourceIndex} className="recording-location-row">
          <span>
            録音{point.sourceIndex + 1}：
            {meeting.sources?.[point.sourceIndex]?.name || "録音ファイル"}
          </span>
          <span>
            緯度 {point.latitude} / 経度 {point.longitude}（精度 ±
            {Math.round(point.accuracy)} m）
          </span>
          <time dateTime={point.capturedAt}>
            {new Date(point.capturedAt).toLocaleString("ja-JP")}
          </time>
          <a
            href={`https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=18/${point.latitude}/${point.longitude}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            地図で場所を確認
          </a>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        disabled={
          saving || isWorking(meeting) || meeting.status === "uploading"
        }
        onClick={remove}
      >
        録音場所をすべて削除
      </button>
    </section>
  );
}
