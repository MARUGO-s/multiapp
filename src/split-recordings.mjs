import {
  Input,
  BlobSource,
  ALL_FORMATS,
  ADTS,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  Mp3OutputFormat,
  WavOutputFormat,
  OggOutputFormat,
  FlacOutputFormat,
  EncodedPacketSink,
  EncodedAudioPacketSource,
  Conversion,
  Quality,
  UnsupportedInputFormatError,
  getFirstEncodableAudioCodec,
} from "mediabunny";
import { validateAdts } from "../supabase/functions/_shared/audio.mjs";

export const BATCH_LIMIT = 100_000_000;
export const PART_LIMIT = 24_000_000;
export const MAX_PARTS = 512;

const formatFor = (codec) =>
  codec === "aac"
    ? new Mp4OutputFormat({ fastStart: false })
    : codec === "mp3"
      ? new Mp3OutputFormat()
      : codec === "flac"
        ? new FlacOutputFormat()
        : ["opus", "vorbis"].includes(codec)
          ? new OggOutputFormat()
          : new WavOutputFormat();
const fileTypeFor = (codec) => {
  const format = formatFor(codec);
  return {
    extension: codec === "aac" ? ".m4a" : format.fileExtension,
    type:
      codec === "aac"
        ? "audio/mp4"
        : codec === "opus" || codec === "vorbis"
          ? "audio/ogg"
          : format.mimeType,
  };
};
const unsupported = (codec) =>
  `この音声形式${codec ? `（${codec.toUpperCase()}）` : ""}には対応していません。音声をM4A・MP3・WAVで書き出すか、動画をAAC音声のMP4で書き出してください。`;

// Audio that cannot be copied into a transcribable container (Dolby in MKV/MTS,
// big-endian PCM from camera MOV files, ...) is decoded and re-encoded as speech.
const SPEECH = {
  numberOfChannels: 1,
  sampleRate: 16_000,
  quality: new Quality({ bitrate: 32_000 }),
};
let speechCodec, ac3Decoder;
const getSpeechCodec = () =>
  (speechCodec ??= getFirstEncodableAudioCodec(
    ["opus", "aac", "pcm-s16"],
    SPEECH,
  ));
const loadAc3Decoder = () =>
  (ac3Decoder ??= import("@mediabunny/ac3").then((m) =>
    m.registerAc3Decoder(),
  ));

// Packets are copied when possible (not decoded), keeping memory bounded and audio
// lossless. Each result has its own container/header and zero-based timestamps.
export async function splitRecordings(
  files,
  progress = (_progress) => {},
  options = {},
) {
  if (
    !files.length ||
    files.length > 5 ||
    files.some((f) => !f.size) ||
    files.reduce((n, f) => n + f.size, 0) > BATCH_LIMIT
  )
    throw new Error("録音は最大5ファイル、合計100 MB以下で選んでください。");
  const byteLimit = options.byteLimit ?? 20_000_000;
  const durationLimit = options.durationLimit ?? 600;
  const parts = [];
  for (const [sourceIndex, file] of files.entries()) {
    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });
    let output,
      partNumber = 0;
    const addPart = (blob, extension, duration) => {
      if (blob.size > PART_LIMIT)
        throw new Error(
          "分割後の音声が大きすぎます。別の音声形式で書き出してください。",
        );
      parts.push({
        blob,
        name: `recording-${sourceIndex + 1}-${++partNumber}${extension}`,
        fileName: file.name,
        sourceIndex,
        partNumber,
        duration,
      });
      if (
        parts.length > MAX_PARTS ||
        parts.reduce((n, p) => n + p.blob.size, 0) > 110_000_000
      )
        throw new Error(
          "分割後のデータ量が上限を超えます。録音を複数の会議に分けてください。",
        );
    };
    try {
      let codec, decoderConfig, packets;
      if ((await input.getFormat()) === ADTS) {
        codec = "aac";
        ({ decoderConfig, packets } = validateAdts(
          new Uint8Array(await file.arrayBuffer()),
        ));
      } else {
        // Video files are accepted too: only the primary audio track is read.
        const track = await input.getPrimaryAudioTrack();
        if (!track)
          throw new Error(
            "音声トラックがありません。音声付きの動画か録音ファイルを選んでください。",
          );
        codec = await track.getCodec();
        if (
          !codec ||
          !formatFor(codec).getSupportedAudioCodecs().includes(codec)
        ) {
          await transcode(
            input,
            track,
            codec,
            durationLimit,
            addPart,
            (ratio) => progress({ sourceIndex, ratio }),
          );
          progress({ sourceIndex, ratio: 1 });
          continue;
        }
        decoderConfig = await track.getDecoderConfig();
        packets = new EncodedPacketSink(track).packets();
      }
      const { extension, type } = fileTypeFor(codec);
      let target,
        source,
        start = 0,
        end = 0,
        bytes = 0,
        count = 0,
        consumed = 0;
      const finish = async () => {
        if (!count) return;
        await output.finalize();
        addPart(new Blob([target.buffer], { type }), extension, end - start);
        count = 0;
        bytes = 0;
      };
      for await (const packet of packets) {
        if (
          count &&
          (bytes + packet.data.byteLength > byteLimit ||
            packet.timestamp - start >= durationLimit)
        )
          await finish();
        if (!count) {
          target = new BufferTarget();
          output = new Output({ format: formatFor(codec), target });
          source = new EncodedAudioPacketSource(codec);
          output.addAudioTrack(source);
          await output.start();
          start = packet.timestamp;
        }
        await source.add(
          packet.clone({ timestamp: packet.timestamp - start }),
          count === 0 ? { decoderConfig } : undefined,
        );
        bytes += packet.data.byteLength;
        consumed += packet.data.byteLength;
        end = Math.max(end, packet.timestamp + packet.duration);
        if (++count % 400 === 0)
          progress({ sourceIndex, ratio: Math.min(1, consumed / file.size) });
      }
      await finish();
      if (!partNumber) throw new Error("音声が空です。");
      progress({ sourceIndex, ratio: 1 });
    } catch (error) {
      if (output && output.state !== "finalized")
        await output.cancel().catch(() => {});
      const message =
        error instanceof UnsupportedInputFormatError
          ? "ファイル形式を読み取れません。MP4・MOV・MKV・WebM・MTSの動画か、M4A・MP3・WAVの音声で書き出してください。"
          : error.message || "音声を読み込めませんでした。";
      throw new Error(`録音${sourceIndex + 1}「${file.name}」: ${message}`);
    } finally {
      input.dispose();
    }
  }
  return parts;
}

// The reverse of splitRecordings for one recording: the parts' packets are copied
// (not re-encoded) into one file, each part starting where the previous one ended.
export async function joinRecordings(blobs) {
  const target = new BufferTarget();
  let output, source, codec, decoderConfig, fileType, added = false,
    offset = 0;
  try {
    for (const blob of blobs) {
      const input = new Input({
        source: new BlobSource(blob),
        formats: ALL_FORMATS,
      });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track) throw new Error("音声トラックがありません。");
        const partCodec = await track.getCodec();
        if (!output) {
          codec = partCodec;
          if (
            !codec ||
            !formatFor(codec).getSupportedAudioCodecs().includes(codec)
          )
            throw new Error(unsupported(codec));
          fileType = fileTypeFor(codec);
          decoderConfig = await track.getDecoderConfig();
          output = new Output({ format: formatFor(codec), target });
          source = new EncodedAudioPacketSource(codec);
          output.addAudioTrack(source);
          await output.start();
        } else if (partCodec !== codec)
          throw new Error("分割した録音の形式が一致しないため、1つにまとめられません。");
        let first,
          end = offset;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          first ??= packet.timestamp;
          const timestamp = offset + packet.timestamp - first;
          await source.add(
            packet.clone({ timestamp }),
            added ? undefined : { decoderConfig },
          );
          added = true;
          end = Math.max(end, timestamp + packet.duration);
        }
        offset = end;
      } finally {
        input.dispose();
      }
    }
    if (!added) throw new Error("音声が空です。");
    await output.finalize();
  } catch (error) {
    if (output && output.state !== "finalized")
      await output.cancel().catch(() => {});
    throw error;
  }
  return {
    blob: new Blob([target.buffer], { type: fileType.type }),
    extension: fileType.extension,
  };
}

// Equal-length segments avoid a tiny trailing part; each stays within the limit.
async function transcode(input, track, codec, durationLimit, addPart, report) {
  if (codec === "ac3" || codec === "eac3") await loadAc3Decoder();
  const target = codec && (await track.canDecode()) && (await getSpeechCodec());
  if (!target) throw new Error(unsupported(codec));
  const first = Math.max(0, await track.getFirstTimestamp());
  const total = (await track.computeDuration()) - first;
  if (!(total > 0)) throw new Error("音声が空です。");
  const count = Math.ceil(total / durationLimit);
  const { extension, type } = fileTypeFor(target);
  let reported = 0;
  for (let i = 0; i < count; i++) {
    const start = first + (total * i) / count;
    const end = first + (total * (i + 1)) / count;
    const buffer = new BufferTarget();
    const conversion = await Conversion.init({
      input,
      output: new Output({ format: formatFor(target), target: buffer }),
      tracks: "primary",
      video: { discard: true },
      audio: { ...SPEECH, codec: target, forceTranscode: true },
      trim: { start, end },
    });
    if (!conversion.isValid) throw new Error(unsupported(codec));
    conversion.onProgress = (ratio) => {
      const overall = (start - first + ratio * (end - start)) / total;
      if (overall - reported >= 0.01) report((reported = overall));
    };
    await conversion.execute();
    addPart(new Blob([buffer.buffer], { type }), extension, end - start);
  }
}

export const VIDEO_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".ts",
  ".mts",
  ".m2ts",
  ".3gp",
];

async function convertAudio(file, { compress, onProgress }) {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    if (!compress && !(await input.getPrimaryVideoTrack())) return file;
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("音声が含まれていません。");
    let codec = await track.getCodec(),
      audio;
    if (
      compress ||
      !codec ||
      !formatFor(codec).getSupportedAudioCodecs().includes(codec)
    ) {
      if (codec === "ac3" || codec === "eac3") await loadAc3Decoder();
      const target =
        codec && (await track.canDecode()) && (await getSpeechCodec());
      if (!target) throw new Error(unsupported(codec));
      codec = target;
      audio = { ...SPEECH, codec, forceTranscode: true };
    }
    const { extension, type } = fileTypeFor(codec);
    const target = new BufferTarget();
    const conversion = await Conversion.init({
      input,
      output: new Output({ format: formatFor(codec), target }),
      tracks: "primary",
      video: { discard: true },
      audio,
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error(unsupported(codec));
    if (onProgress) conversion.onProgress = onProgress;
    await conversion.execute();
    return new File(
      [target.buffer],
      file.name.replace(/\.[^.]+$/, "") + extension,
      { type },
    );
  } catch (error) {
    throw new Error(
      `「${file.name}」: ${
        error instanceof UnsupportedInputFormatError
          ? "ファイル形式を読み取れません。MP4・MOV・MKV・WebM・MTSの動画か、M4A・MP3・WAVの音声で書き出してください。"
          : error.message || "音声を読み込めませんでした。"
      }`,
    );
  } finally {
    input.dispose();
  }
}

// Video files are far larger than their audio, so keep only the audio track
// (copied without re-encoding when possible) before size limits are applied.
export function extractAudio(file, onProgress) {
  return convertAudio(file, { compress: false, onProgress });
}

// Re-encode as mono speech (about 14 MB per hour) when recordings are too large.
export function compressAudio(file, onProgress) {
  return convertAudio(file, { compress: true, onProgress });
}
