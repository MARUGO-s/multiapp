import { RecordingLocationSchema } from "../supabase/functions/_shared/recording-location.mjs";
import { z } from "zod";

const fileLocations = new WeakMap();
export function rememberRecordingLocation(file, point) {
  if (point) fileLocations.set(file, RecordingLocationSchema.parse(point));
  return file;
}
export const getRecordingLocation = (file) => fileLocations.get(file) ?? null;
// Explicit metadata survives FormData's File cloning and offline serialization.
export function sourcesWithRecordingLocations(files, serialized) {
  const points =
    serialized === null
      ? files.map(() => null)
      : z
          .array(RecordingLocationSchema.nullable())
          .length(files.length)
          .parse(JSON.parse(serialized));
  return files.map((file, index) => ({
    name: file.name,
    size: file.size,
    ...(points[index] ? { startLocation: points[index] } : {}),
  }));
}

// One request, owned by one successfully started recorder. Never watch/track.
export function captureRecordingLocation({ enabled, geolocation, onLocation }) {
  let active = true;
  const cancel = () => {
    active = false;
  };
  if (!enabled || !geolocation) return cancel;
  try {
    geolocation.getCurrentPosition(
      (position) => {
        if (!active) return;
        active = false;
        try {
          const parsed = RecordingLocationSchema.safeParse({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            capturedAt: new Date(position.timestamp).toISOString(),
          });
          if (parsed.success) onLocation(parsed.data);
        } catch {
          /* Location failure must never interrupt recording. */
        }
      },
      cancel,
      { enableHighAccuracy: false, maximumAge: 0, timeout: 10000 },
    );
  } catch {
    cancel();
  }
  return cancel;
}
