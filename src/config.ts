import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  ALLOWED_USER_IDS: z
    .string()
    .min(1, "ALLOWED_USER_IDS is required")
    .transform((s) => s.split(",").map(Number))
    .pipe(z.array(z.number().int().positive())),
  CHAT_ID: z.coerce.number().int(),
  NOTIFY_PORT: z.coerce.number().int().min(1).default(3847),
  SEND_KEYS_DELAY_MS: z.coerce.number().int().min(0).default(500),
  WHISPER_CLI_PATH: z.string().optional(),
  WHISPER_MODEL_PATH: z.string().optional(),
  FFMPEG_PATH: z.string().default("ffmpeg"),
});

export type Config = z.infer<typeof configSchema>;
export const config: Config = configSchema.parse(process.env);
