// One downloadable file per selected recording. Uploads made in the browser store each
// recording as parts named "<recording>（n）"; older meetings store whole files.
export function recordingFiles(recordings) {
  const files = [];
  const bySource = new Map();
  recordings.forEach((part, index) => {
    const split = Number.isInteger(part.sourceIndex);
    let file = split ? bySource.get(part.sourceIndex) : undefined;
    if (!file) {
      file = {
        name: split ? part.fileName.replace(/（\d+）$/, "") : part.fileName,
        parts: [],
      };
      files.push(file);
      if (split) bySource.set(part.sourceIndex, file);
    }
    file.parts.push(index);
  });
  return files;
}

const extensions = {
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};
// The saved audio can be in another container than the selected file (AAC is
// kept as M4A), so the extension follows the saved data's type.
export const savedAudioExtension = (type, name) =>
  extensions[type.split(";")[0].trim().toLowerCase()] ||
  name.match(/\.[^.]+$/)?.[0].toLowerCase() ||
  "";
export const audioFileName = (name, extension) =>
  `${name.replace(/\.[^.]+$/, "") || "録音"}${extension}`;
