import { test } from "node:test";
import assert from "node:assert/strict";
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from "mediabunny";
import { joinRecordings, splitRecordings } from "../src/split-recordings.mjs";
import {
  audioFileName,
  recordingFiles,
  savedAudioExtension,
} from "../src/recording-files.mjs";
import {
  validateAdts,
  transcribeRecordings,
  publicRecordings,
} from "../supabase/functions/_shared/audio.mjs";
import { UploadSchema } from "../supabase/functions/_shared/upload.mjs";
import { aacFixture } from "./fixtures/aac.mjs";
import { createHash } from "node:crypto";
import { waveFile } from "./fixtures/wav.mjs";
import { videoFixtures, aacFrames } from "./fixtures/video.mjs";

async function readParts(parts) {
  const result = [];
  for (const part of parts) {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(part.blob),
    });
    try {
      const track = await input.getPrimaryAudioTrack();
      const packets = [];
      for await (const packet of new EncodedPacketSink(track).packets())
        packets.push(packet.data);
      result.push({
        codec: await track.getCodec(),
        sampleRate: track.sampleRate,
        channels: track.numberOfChannels,
        duration: await input.computeDuration(),
        packets,
      });
    } finally {
      input.dispose();
    }
  }
  return result;
}

test("動画（MOV・MKV・MTS）のDolbyやビッグエンディアンPCM音声を16 kHzモノラルへ変換して分割する", async () => {
  for (const make of [
    videoFixtures.movPcmBigEndian,
    videoFixtures.mkvAc3,
    videoFixtures.m2tsAc3,
  ]) {
    const file = await make();
    const ratios = [];
    const parts = await splitRecordings(
      [file],
      ({ ratio }) => ratios.push(ratio),
      { durationLimit: 1 },
    );
    const decoded = await readParts(parts);
    const total = parts.reduce((n, p) => n + p.duration, 0);
    assert.ok(Math.abs(total - 3) < 0.05, `${file.name}: ${total}`);
    assert.equal(parts.length, Math.ceil(total));
    assert.ok(parts.every((p) => p.duration <= 1 && p.fileName === file.name));
    assert.deepEqual(
      parts.map((p) => p.name),
      parts.map((_, i) => `recording-1-${i + 1}.wav`),
    );
    // Without WebCodecs (Node), speech falls back to 16-bit PCM WAV.
    for (const part of decoded) {
      assert.deepEqual(
        [part.codec, part.sampleRate, part.channels],
        ["pcm-s16", 16000, 1],
      );
      assert.ok(Math.abs(part.duration - total / parts.length) < 0.01);
    }
    const pcm = new Int16Array(
      Buffer.concat(decoded.flatMap((p) => p.packets)).buffer.slice(0),
    );
    let crossings = 0,
      peak = 0;
    for (let i = 1; i < pcm.length; i++) {
      if (pcm[i - 1] < 0 !== pcm[i] < 0) crossings++;
      peak = Math.max(peak, Math.abs(pcm[i]));
    }
    assert.ok(peak > 0.3 * 32768, `${file.name}: silent output`);
    const hz = crossings / 2 / (pcm.length / 16000);
    assert.ok(Math.abs(hz - 440) < 10, `${file.name}: ${hz} Hz`);
    assert.equal(ratios.at(-1), 1);
    assert.ok(ratios.every((r, i) => !i || r >= ratios[i - 1]));
  }
});

test("MP4・MPEG-TSの動画内AAC音声は再圧縮せずにM4Aへ取り出す", async () => {
  const expected = [...aacFrames().packets].map((p) =>
    p.data.slice(p.data[1] & 1 ? 7 : 9),
  );
  for (const make of [videoFixtures.mp4Aac, videoFixtures.tsAac]) {
    const file = await make();
    const parts = await splitRecordings([file]);
    assert.deepEqual(
      parts.map((p) => [p.name, p.blob.type]),
      [["recording-1-1.m4a", "audio/mp4"]],
    );
    const [decoded] = await readParts(parts);
    assert.equal(decoded.codec, "aac");
    assert.deepEqual(decoded.packets, expected, file.name);
  }
});

test("対応できない動画は理由を示して拒否する", async () => {
  await assert.rejects(
    splitRecordings([await videoFixtures.mkvDts()]),
    /録音1「dts\.mkv」: この音声形式（DTS）には対応していません/,
  );
  await assert.rejects(
    splitRecordings([await videoFixtures.movSilent()]),
    /音声トラックがありません/,
  );
  await assert.rejects(
    splitRecordings([new File([new Uint8Array(4096).fill(7)], "broken.mov")]),
    /ファイル形式を読み取れません/,
  );
});
test("100,000,000バイトの単一WAVを分割し、全PCMバイトを順序通り保持する", async () => {
  const file = waveFile();
  const parts = await splitRecordings([file]);
  assert.ok(parts.length >= 5);
  const actual = createHash("sha256");
  let size = 0,
    duration = 0;
  for (const part of parts) {
    assert.ok(part.blob.size <= 24_000_000);
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(part.blob),
    });
    try {
      const track = await input.getPrimaryAudioTrack();
      const sink = new EncodedPacketSink(track);
      let first = true;
      for await (const packet of sink.packets()) {
        if (first) assert.equal(packet.timestamp, 0);
        first = false;
        actual.update(packet.data);
        size += packet.data.length;
      }
      duration += await input.computeDuration();
    } finally {
      input.dispose();
    }
  }
  assert.equal(size, file.size - 44);
  assert.equal(
    actual.digest("hex"),
    createHash("sha256")
      .update(new Uint8Array(await file.slice(44).arrayBuffer()))
      .digest("hex"),
  );
  assert.ok(Math.abs(duration - (file.size - 44) / 176400) < 0.001);
});
test("65分・62.4MBのWAVを7分割し、時間とPCMの欠落・重複がない", async () => {
  const bytes = new Uint8Array(await waveFile(3900 * 16000 + 44).arrayBuffer());
  const header = new DataView(bytes.buffer);
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, 8000, true);
  header.setUint32(28, 16000, true);
  header.setUint16(32, 2, true);
  const parts = await splitRecordings([
    new File([bytes], "65-minutes.wav", { type: "audio/wav" }),
  ]);
  assert.equal(parts.length, 7);
  let duration = 0,
    total = 0;
  const hash = createHash("sha256");
  for (const part of parts) {
    assert.ok(part.blob.size <= 20_000_000);
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(part.blob),
    });
    try {
      const seconds = await input.computeDuration();
      assert.ok(seconds <= 601);
      duration += seconds;
      for await (const packet of new EncodedPacketSink(
        await input.getPrimaryAudioTrack(),
      ).packets()) {
        hash.update(packet.data);
        total += packet.data.length;
      }
    } finally {
      input.dispose();
    }
  }
  assert.equal(total, bytes.length - 44);
  assert.ok(Math.abs(duration - 3900) < 0.001);
  assert.equal(
    hash.digest("hex"),
    createHash("sha256").update(bytes.subarray(44)).digest("hex"),
  );
});
test("AACはフレームの欠落・重複なしで時間境界分割し、録音の順序を保つ", async () => {
  const files = [
    new File([aacFixture, aacFixture], "first.aac"),
    new File([aacFixture], "second.aac"),
  ];
  const parts = await splitRecordings(files, () => {}, { durationLimit: 0.05 });
  assert.ok(parts.length > 2);
  for (let sourceIndex = 0; sourceIndex < files.length; sourceIndex++) {
    const expected = [
      ...validateAdts(new Uint8Array(await files[sourceIndex].arrayBuffer()))
        .packets,
    ].map((p) => p.data.slice(p.data[1] & 1 ? 7 : 9));
    const actual = [];
    for (const part of parts.filter((p) => p.sourceIndex === sourceIndex)) {
      const input = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(part.blob),
      });
      try {
        for await (const packet of new EncodedPacketSink(
          await input.getPrimaryAudioTrack(),
        ).packets())
          actual.push(packet.data);
      } finally {
        input.dispose();
      }
    }
    assert.deepEqual(actual, expected);
  }
  await assert.rejects(
    splitRecordings([new File([aacFixture.slice(0, -1)], "broken.aac")]),
    /録音1/,
  );
});
test("合計100 MBの境界、マニフェストの順序、件数、分割サイズを両側で検証する", async () => {
  const input = {
    metadata: { title: "test", date: "2026-09-23" },
    sources: [{ name: "a.wav", size: 100_000_000 }],
    parts: [
      {
        name: "recording-1-1.wav",
        size: 100,
        sourceIndex: 0,
        partNumber: 1,
        duration: 1,
      },
    ],
  };
  assert.ok(UploadSchema.safeParse(input).success);
  for (const mutation of [
    (v) => v.sources[0].size++,
    (v) => (v.parts[0].size = 24_000_001),
    (v) => (v.parts[0].sourceIndex = 1),
    (v) => (v.parts[0].partNumber = 2),
    (v) => v.sources.push(...Array(5).fill(v.sources[0])),
  ]) {
    const copy = structuredClone(input);
    mutation(copy);
    assert.equal(UploadSchema.safeParse(copy).success, false);
  }
  await assert.rejects(splitRecordings([{ size: 100_000_001 }]), /100 MB/);
  await assert.rejects(
    splitRecordings([{ size: 50_000_000 }, { size: 50_000_001 }]),
    /100 MB/,
  );
});
test("別モデルで文字起こしした録音を記録し、失敗した録音の番号を返す", async () => {
  const fallback = { model: "gpt-transcribe", geminiStatus: "incomplete" };
  let saved;
  const text = await transcribeRecordings(
    [{ fileName: "a.m4a" }, { fileName: "b.m4a" }],
    async (_part, index) =>
      index === 0
        ? { transcript: "代わりのモデル", transcriptionFallback: fallback }
        : "通常のモデル",
    async (parts) => {
      saved = parts;
    },
  );
  assert.equal(text, "【録音 1】\n代わりのモデル\n\n【録音 2】\n通常のモデル");
  assert.deepEqual(saved[0].transcriptionFallback, fallback);
  assert.equal(saved[1].transcriptionFallback, undefined);
  assert.deepEqual(publicRecordings(saved), [
    { fileName: "a.m4a", transcribed: true, fallbackModel: "gpt-transcribe" },
    { fileName: "b.m4a", transcribed: true },
  ]);
  await assert.rejects(
    transcribeRecordings(
      [{ fileName: "a.m4a", transcript: "済み" }, { fileName: "b.m4a" }],
      async () => {
        throw Object.assign(new Error("incomplete"), {
          code: "GEMINI_TRANSCRIPT_INCOMPLETE",
          geminiStatus: "incomplete",
        });
      },
      async () => {},
    ),
    (error) =>
      error.partIndex === 1 &&
      error.cause.code === "GEMINI_TRANSCRIPT_INCOMPLETE" &&
      /録音2.*状態：incomplete/.test(error.publicMessage),
  );
});
test("分割文字起こしは1回1本、保存済みをスキップし最終回だけ連結する", async () => {
  let parts = Array.from({ length: 8 }, (_, i) => ({
    fileName: `${i}.wav`,
    transcript: "",
  }));
  const calls = [];
  for (let i = 0; i < parts.length; i++) {
    const text = await transcribeRecordings(
      parts,
      async (_, index) => {
        calls.push(index);
        return `会話${index}`;
      },
      async (next) => {
        parts = next;
      },
      1,
    );
    if (i < 7) assert.equal(text, null);
    else assert.ok(text.endsWith("会話7"));
  }
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5, 6, 7]);
});

async function readJoined(blob) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    const packets = [];
    let last = -Infinity;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      assert.ok(packet.timestamp > last, "timestamps keep increasing across parts");
      last = packet.timestamp;
      packets.push(packet.data);
    }
    return { codec: await track.getCodec(), duration: await input.computeDuration(), packets };
  } finally {
    input.dispose();
  }
}
test("自動分割した録音を元の順序で1ファイルに戻し、音声データを欠落・重複なく保持する", async () => {
  const aac = new File([aacFixture, aacFixture], "first.aac");
  const wav = waveFile(176400 * 3 + 44);
  for (const [file, durationLimit, codec, extension, type] of [
    [aac, 0.05, "aac", ".m4a", "audio/mp4"],
    [wav, 1, "pcm-s16", ".wav", "audio/wav"],
  ]) {
    const parts = await splitRecordings([file], () => {}, { durationLimit });
    assert.ok(parts.length > 2, file.name);
    const expected = (await readParts(parts)).flatMap((p) => p.packets);
    const joined = await joinRecordings(parts.map((p) => p.blob));
    assert.equal(joined.extension, extension);
    assert.equal(joined.blob.type, type);
    const actual = await readJoined(joined.blob);
    assert.equal(actual.codec, codec);
    assert.deepEqual(actual.packets, expected, file.name);
    const total = parts.reduce((n, p) => n + p.duration, 0);
    assert.ok(Math.abs(actual.duration - total) < 0.05, `${file.name}: ${actual.duration}`);
  }
  const wavPcm = new Uint8Array(await wav.slice(44).arrayBuffer());
  const wavParts = await splitRecordings([wav], () => {}, { durationLimit: 1 });
  const joinedWav = await readJoined((await joinRecordings(wavParts.map((p) => p.blob))).blob);
  assert.deepEqual(Buffer.concat(joinedWav.packets), Buffer.from(wavPcm));
  const [aacPart] = await splitRecordings([aac]);
  await assert.rejects(
    joinRecordings([aacPart.blob, wavParts[0].blob]),
    /形式が一致しない/,
  );
  await assert.rejects(joinRecordings([]), /音声が空です/);
});
test("録音ごとのダウンロードファイルにまとめ、保存形式の拡張子で名前を付ける", () => {
  assert.deepEqual(
    publicRecordings([
      { fileName: "定例.mp3（1）", transcript: "済み", audioPath: "owner/secret.mp3", sourceIndex: 0 },
      { fileName: "旧.wav", transcript: "" },
    ]),
    [
      { fileName: "定例.mp3（1）", transcribed: true, sourceIndex: 0 },
      { fileName: "旧.wav", transcribed: false },
    ],
  );
  assert.deepEqual(
    recordingFiles([
      { fileName: "定例.mp3（1）", sourceIndex: 0 },
      { fileName: "定例.mp3（2）", sourceIndex: 0 },
      { fileName: "追加（2）.AAC（1）", sourceIndex: 1 },
    ]),
    [
      { name: "定例.mp3", parts: [0, 1] },
      { name: "追加（2）.AAC", parts: [2] },
    ],
  );
  // Whole files saved before automatic splitting are each their own download.
  assert.deepEqual(
    recordingFiles([{ fileName: "前半.wav" }, { fileName: "前半.wav" }]),
    [
      { name: "前半.wav", parts: [0] },
      { name: "前半.wav", parts: [1] },
    ],
  );
  assert.equal(audioFileName("追加.AAC", savedAudioExtension("audio/mp4", "追加.AAC")), "追加.m4a");
  assert.equal(audioFileName("定例.mp3", ".mp3"), "定例.mp3");
  assert.equal(savedAudioExtension("application/octet-stream", "録音.WAV"), ".wav");
  assert.equal(savedAudioExtension("audio/ogg; codecs=opus", "x"), ".ogg");
  assert.equal(audioFileName(".m4a", ".m4a"), "録音.m4a");
});
