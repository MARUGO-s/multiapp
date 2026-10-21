import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { MAX_TEXT_LENGTH } from "./domain.mjs";
import {
  AllFormatsMinutesSchema,
  MINUTES_OUTPUT_TOKENS,
  parseMinutes,
  summaryInput,
} from "../supabase/functions/_shared/summary.mjs";
import {
  GEMINI_TRANSCRIPTION_MODEL,
  transcribeWithGemini,
} from "../supabase/functions/_shared/gemini-transcribe.mjs";

export function createAI(
  apiKey,
  model,
  clientOptions = {},
  { transcriptionModel = "gpt-transcribe", geminiApiKey = "" } = {},
) {
  const client = new OpenAI({
    apiKey,
    timeout: 15 * 60_000,
    maxRetries: 1,
    ...clientOptions,
  });
  return {
    async insight(request, onUsage = () => {}) {
      const response = await client.responses.create(request);
      await onUsage(response);
      return response;
    },
    async transcribe(filePath, onUsage = () => {}) {
      if (transcriptionModel === GEMINI_TRANSCRIPTION_MODEL) {
        const bytes = await readFile(filePath);
        const transcript = await transcribeWithGemini(
          geminiApiKey,
          new Blob([bytes]),
          path.basename(filePath),
          onUsage,
        );
        return { transcript, segments: [], duration: null };
      }
      const response = await client.audio.transcriptions.create({
        file: createReadStream(filePath),
        model: "gpt-transcribe",
        response_format: "json",
        languages: ["ja"],
      });
      await onUsage(response);
      const transcript = response.text;
      if (!transcript?.trim())
        throw Object.assign(new Error("empty audio"), { code: "EMPTY_AUDIO" });
      // GPT Transcribe does not return speaker IDs or timestamps. Never invent them.
      return { transcript, segments: [], duration: null };
    },
    async summarize(meeting, onUsage = () => {}) {
      if (meeting.transcript.length > MAX_TEXT_LENGTH)
        throw Object.assign(new Error("too long"), { code: "TEXT_TOO_LONG" });
      const response = await client.responses.parse({
        model,
        store: false,
        reasoning: { effort: "medium" },
        max_output_tokens: MINUTES_OUTPUT_TOKENS,
        input: summaryInput(meeting),
        text: {
          format: zodTextFormat(AllFormatsMinutesSchema, "meeting_minutes"),
        },
      });
      await onUsage(response);
      if (response.status !== "completed" || !response.output_parsed)
        throw new Error("No complete structured output");
      return parseMinutes(meeting, response.output_parsed);
    },
  };
}
