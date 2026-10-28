import { z } from "zod";

// No address lookup: this value never enters AI, analytics or logs.
export const RecordingLocationSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracy: z.number().finite().nonnegative(),
    capturedAt: z.iso.datetime(),
  })
  .strict();
