import {
  ADTS,
  BufferSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from "mediabunny";
import {
  audioExtensions,
  MAX_FILE_SIZE,
  MAX_TEXT_LENGTH,
  safeError,
} from "./domain.mjs";

export const MAX_AUDIO_FILES = 5;
export const audioExtension = (name) =>
  `.${name.split(".").pop()?.toLowerCase()}`;
const fail = (message) =>
  Object.assign(new Error(message), { status: 400, publicMessage: message });
const mime = {
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};

export function validateRecordings(files) {
  if (files.length > MAX_AUDIO_FILES) {
    throw fail("1つの会議に取り込める録音は5ファイルまでです。");
  }
  if (
    files.some(
      (file) => !audioExtensions.has(audioExtension(file.name)) || !file.size,
    )
  ) {
    throw fail(
      "空ではない対応音声ファイル（AAC / MP3 / M4A / WAVなど）を選択してください。",
    );
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_FILE_SIZE) {
    throw fail("録音ファイルは1つの会議につき合計24 MB以下にしてください。");
  }
}

// The demuxer tolerates a truncated last frame. Validate framing first so no
// recording tail silently disappears. ID3v2 tags before the audio are allowed.
export function validateAdts(bytes) {
  let offset = 0;
  let frames = 0;
  let config;
  while (
    bytes[offset] === 73 &&
    bytes[offset + 1] === 68 &&
    bytes[offset + 2] === 51
  ) {
    if (offset + 10 > bytes.length) throw new Error("Truncated ID3");
    const size = bytes.subarray(offset + 6, offset + 10);
    if (size.some((byte) => byte & 128)) throw new Error("Invalid ID3");
    offset += 10 + size.reduce((n, byte) => n * 128 + byte, 0);
  }
  const first = offset;
  while (offset < bytes.length) {
    if (
      offset + 7 > bytes.length ||
      bytes[offset] !== 255 ||
      (bytes[offset + 1] & 246) !== 240
    ) {
      throw new Error("Invalid ADTS header");
    }
    const headerSize = bytes[offset + 1] & 1 ? 7 : 9;
    const length =
      ((bytes[offset + 3] & 3) << 11) |
      (bytes[offset + 4] << 3) |
      (bytes[offset + 5] >> 5);
    const nextConfig = `${bytes[offset + 2] & 253}:${bytes[offset + 3] & 192}`;
    if (
      length <= headerSize ||
      offset + length > bytes.length ||
      (bytes[offset + 6] & 3) !== 0 ||
      (config && config !== nextConfig)
    ) {
      throw new Error("Truncated or changing ADTS stream");
    }
    config = nextConfig;
    offset += length;
    if (++frames > 10_000_000) {
      throw fail(
        "AAC録音が長すぎます。短く分割して別の会議として取り込んでください。",
      );
    }
  }
  if (!frames || offset !== bytes.length) throw new Error("No ADTS frames");
  const sampleRate = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
    8000, 7350,
  ][(bytes[first + 2] >> 2) & 15];
  const channels = ((bytes[first + 2] & 1) << 2) | (bytes[first + 3] >> 6);
  if (!sampleRate || !channels) {
    throw new Error("Unsupported AAC configuration");
  }
  const decoderConfig = {
    codec: `mp4a.40.${(bytes[first + 2] >> 6) + 1}`,
    sampleRate,
    numberOfChannels: channels === 7 ? 8 : channels,
  };
  function* packets() {
    // Walk validated frames without building a full seek index in Edge memory.
    let position = first;
    let index = 0;
    while (position < bytes.length) {
      const size =
        ((bytes[position + 3] & 3) << 11) |
        (bytes[position + 4] << 3) |
        (bytes[position + 5] >> 5);
      yield new EncodedPacket(
        bytes.subarray(position, position + size),
        "key",
        (index * 1024) / sampleRate,
        1024 / sampleRate,
      );
      index++;
      position += size;
    }
  }
  return { decoderConfig, packets: packets() };
}

/** Remux AAC packets; never rename raw AAC or decode/re-encode the recording. */
export async function prepareAudio(file) {
  const extension = audioExtension(file.name);
  if (extension !== ".aac") {
    return { blob: file, extension, contentType: mime[extension] };
  }
  let input;
  let output;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    input = new Input({
      source: new BufferSource(bytes),
      formats: [ADTS, MP4],
    });
    let decoderConfig;
    let packets;
    if ((await input.getFormat()) === ADTS) {
      ({ decoderConfig, packets } = validateAdts(bytes));
    } else {
      const track = await input.getPrimaryAudioTrack();
      if (!track || (await track.getCodec()) !== "aac") {
        throw new Error("Not AAC");
      }
      decoderConfig = await track.getDecoderConfig();
      packets = new EncodedPacketSink(track).packets();
    }
    if (!decoderConfig) throw new Error("Missing AAC configuration");
    const chunks = [];
    let written = 0;
    const target = new StreamTarget(
      new WritableStream({
        write({ data, position }) {
          if (position !== written) {
            throw new Error("Non-sequential MP4 output");
          }
          written += data.byteLength;
          if (written > MAX_FILE_SIZE) {
            throw fail(
              "M4Aへの変換後に24 MBを超えます。録音を短くして取り込んでください。",
            );
          }
          chunks.push(data);
        },
      }),
      { chunked: true, chunkSize: 1024 * 1024 },
    );
    // Fragmented MP4 avoids retaining every output packet in Edge memory.
    output = new Output({
      format: new Mp4OutputFormat({
        fastStart: "fragmented",
        minimumFragmentDuration: 10,
      }),
      target,
    });
    const source = new EncodedAudioPacketSource("aac");
    output.addAudioTrack(source);
    await output.start();
    let count = 0;
    for await (const packet of packets) {
      if (++count > 250000) {
        throw fail("AAC録音が長すぎます。短く分割して取り込んでください。");
      }
      await source.add(packet, count === 1 ? { decoderConfig } : undefined);
    }
    if (!count) throw new Error("Empty AAC");
    await output.finalize();
    return {
      blob: new Blob(chunks, { type: "audio/mp4" }),
      extension: ".m4a",
      contentType: "audio/mp4",
    };
  } catch (error) {
    if (output && output.state !== "finalized") {
      await output.cancel().catch(() => {});
    }
    if (error.publicMessage) throw error;
    throw fail(
      "AACを読み込めませんでした。録音の破損や形式をご確認ください。ADTS形式のAAC、またはM4Aで書き出すと取り込めます。",
    );
  } finally {
    input?.dispose();
  }
}

// Seconds from the start of the original recording to this split part, or null
// when an earlier part's length is unknown (timestamps are then omitted).
export function partOffset(parts, index) {
  const part = parts[index];
  if (!Number.isInteger(part?.sourceIndex)) return 0;
  let offset = 0;
  for (const earlier of parts.slice(0, index)) {
    if (earlier.sourceIndex !== part.sourceIndex) continue;
    if (!Number.isFinite(earlier.duration)) return null;
    offset += earlier.duration;
  }
  return offset;
}
/** @param {any} document @param {string | null} legacyAudioPath */
export function recordingsFor(document, legacyAudioPath = null) {
  return document.audioParts?.length
    ? document.audioParts
    : document.audioFile || legacyAudioPath
      ? [
          {
            fileName: document.fileName,
            audioFile: document.audioFile,
            audioPath: legacyAudioPath,
            transcript: document.transcript || "",
          },
        ]
      : [];
}
/** @param {any} document @param {string | null} legacyAudioPath */
export const needsTranscription = (document, legacyAudioPath = null) =>
  recordingsFor(document, legacyAudioPath).some((part) => !part.transcript);
export function publicRecordings(parts) {
  return parts.map((part) => ({
    fileName: part.fileName,
    transcribed: Boolean(part.transcript),
    ...(part.transcriptionFallback
      ? { fallbackModel: part.transcriptionFallback.model }
      : {}),
    // Lets the browser join the split parts back into each selected recording.
    ...(Number.isInteger(part.sourceIndex)
      ? { sourceIndex: part.sourceIndex }
      : {}),
  }));
}

// At most five calls in parallel, bounded by the existing 24 MB batch limit.
// Persist completed parts in a serialized queue; retry only missing parts.
export async function transcribeRecordings(
  parts,
  transcribe,
  saveProgress,
  limit = Infinity,
) {
  const next = parts.map((part) => ({ ...part }));
  const selected = new Set(
    next
      .map((p, i) => (!p.transcript ? i : -1))
      .filter((i) => i >= 0)
      .slice(0, limit),
  );
  let saving = Promise.resolve();
  const results = await Promise.allSettled(
    next.map(async (part, index) => {
      if (part.transcript || !selected.has(index)) return;
      // A callback may return { transcript, transcriptionFallback } to record
      // that another model transcribed this part.
      const result = await transcribe(part, index);
      const text = typeof result === "string" ? result : result?.transcript;
      if (result?.transcriptionFallback)
        part.transcriptionFallback = result.transcriptionFallback;
      if (typeof text !== "string" || !text.trim()) {
        throw Object.assign(new Error("empty"), { code: "EMPTY_AUDIO" });
      }
      if (
        next.reduce((n, p) => n + (p.transcript?.length || 0), text.length) >
        MAX_TEXT_LENGTH
      ) {
        throw Object.assign(new Error("long"), { code: "TEXT_TOO_LONG" });
      }
      part.transcript = text;
      const snapshot = next.map((p) => ({ ...p }));
      saving = saving.then(() => saveProgress(snapshot));
      await saving;
    }),
  );
  await saving;
  const failed = results.findIndex((result) => result.status === "rejected");
  if (failed !== -1) {
    const error = results[failed].reason;
    throw Object.assign(
      new Error("Recording transcription failed", { cause: error }),
      {
        partIndex: failed,
        diagnosticCode:
          error?.code ||
          (error?.status ? `HTTP_${error.status}` : error?.name || "UNKNOWN"),
        publicMessage: `録音${failed + 1}の文字起こしに失敗しました。${safeError(
          error,
        )} 完了した録音は再処理せず、未完了分から再試行できます。`,
      },
    );
  }
  if (next.some((part) => !part.transcript)) return null;
  const transcript = next
    .map((part, i) =>
      next.length === 1
        ? part.transcript
        : `【録音 ${i + 1}】\n${part.transcript}`,
    )
    .join("\n\n");
  if (transcript.length > MAX_TEXT_LENGTH) {
    throw Object.assign(new Error("long"), { code: "TEXT_TOO_LONG" });
  }
  return transcript;
}
