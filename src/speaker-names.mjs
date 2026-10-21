// Speaker numbers (話者0, 話者1, …) restart in every recording, so a name is
// stored per recording: { "録音1:話者0": "佐藤" }. The saved transcript and
// minutes keep the numbers; names are applied when they are shown or
// exported, so a name can be corrected again at any time.

const TURN = /^((?:\[\d{2,}:\d{2}\]\s*)?)(話者\d+)([：:])/;
const RECORDING = /^【録音 (\d+)】$/;
const IN_RECORDING = /話者(\d+)\s*[（(]録音\s*(\d+)[）)]/g;
const BARE = /話者(\d+)(?!\d|\s*[（(]録音)/g;

export const speakerKey = (recording, speaker) => `録音${recording}:${speaker}`;

// Speakers in the order they first speak, with how often they speak.
export function transcriptSpeakers(transcript) {
  const found = new Map();
  let recording = 1;
  for (const raw of String(transcript || "").split("\n")) {
    const line = raw.trim();
    const heading = RECORDING.exec(line);
    if (heading) {
      recording = Number(heading[1]);
      continue;
    }
    const turn = TURN.exec(line);
    if (!turn) continue;
    const key = speakerKey(recording, turn[2]);
    const entry = found.get(key) || { key, recording, speaker: turn[2], turns: 0 };
    entry.turns++;
    found.set(key, entry);
  }
  return [...found.values()];
}

export function recordingCount(transcript) {
  const numbers = new Set([1]);
  for (const line of String(transcript || "").split("\n")) {
    const heading = RECORDING.exec(line.trim());
    if (heading) numbers.add(Number(heading[1]));
  }
  return numbers.size;
}

const nameOf = (names, key) => {
  const name = names?.[key];
  return typeof name === "string" && name.trim() ? name.trim() : null;
};

// Minutes write 「話者0（録音1）」. A bare 「話者0」 is only unambiguous when the
// meeting has a single recording.
export function applySpeakerNames(text, names, recordings = 1) {
  if (!text || !names || !Object.keys(names).length) return text;
  let next = String(text).replace(IN_RECORDING, (match, n, r) => nameOf(names, speakerKey(Number(r), `話者${n}`)) ?? match);
  if (recordings === 1)
    next = next.replace(BARE, (match, n) => nameOf(names, speakerKey(1, `話者${n}`)) ?? match);
  return next;
}

// Transcript text for download, with each line's speaker replaced by its name.
export function transcriptWithNames(transcript, names) {
  if (!transcript || !names || !Object.keys(names).length) return transcript;
  let recording = 1;
  return String(transcript)
    .split("\n")
    .map((line) => {
      const heading = RECORDING.exec(line.trim());
      if (heading) recording = Number(heading[1]);
      return line.replace(TURN, (match, time, speaker, colon) => {
        const name = nameOf(names, speakerKey(recording, speaker));
        return name ? `${time}${name}${colon}` : match;
      });
    })
    .join("\n");
}

// The names to save: blank entries are removed so the number shows again.
/** @returns {Record<string, string>} */
export function cleanSpeakerNames(draft) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(draft || {})) {
    const name = String(value ?? "").trim();
    if (name) out[key] = name.slice(0, 100);
  }
  return out;
}
