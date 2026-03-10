import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot, InlineKeyboard } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TmuxManager } from "./tmux-manager.js";
import type { SessionMapper } from "./session-mapper.js";
import { config } from "../config.js";

const execFileAsync = promisify(execFileCb);

const MAX_VOICE_DURATION_SEC = 60;

// Filter BOT_TOKEN from child process environment
const filteredEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "BOT_TOKEN"),
);

// Store transcriptions keyed by message ID (callback data is limited to 64 bytes)
const pendingTranscriptions = new Map<
  string,
  { text: string; sessionName: string }
>();

function isVoiceConfigured(): boolean {
  return !!(
    config.FFMPEG_PATH &&
    config.WHISPER_CLI_PATH &&
    config.WHISPER_MODEL_PATH
  );
}

export function createVoiceHandler(
  bot: Bot<AppContext>,
  tmux: TmuxManager,
  sessionMapper: SessionMapper,
): void {
  let transcriptionInProgress = false;

  bot.on("message:voice", async (ctx) => {
    // Check thread ID - voice messages outside topics are ignored
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) return;

    // Check session mapping
    const mapping = sessionMapper.getByTopic(threadId);
    if (!mapping) return;

    // Check if voice is configured
    if (!isVoiceConfigured()) {
      await ctx.reply(
        "Voice messages not configured. Install ffmpeg and whisper.cpp to enable.",
        { message_thread_id: threadId },
      );
      return;
    }

    // Concurrency guard
    if (transcriptionInProgress) {
      await ctx.reply(
        "A transcription is already in progress. Please wait.",
        { message_thread_id: threadId },
      );
      return;
    }

    // Check voice duration
    const duration = ctx.message.voice.duration;
    if (duration > MAX_VOICE_DURATION_SEC) {
      await ctx.reply(
        `Voice message too long (${duration}s). Maximum is ${MAX_VOICE_DURATION_SEC} seconds.`,
        { message_thread_id: threadId },
      );
      return;
    }

    transcriptionInProgress = true;
    let tempDir: string | undefined;

    try {
      // Create isolated temp directory
      tempDir = await mkdtemp(join(tmpdir(), "tg-voice-"));

      const oggPath = join(tempDir, "voice.ogg");
      const wavPath = join(tempDir, "voice.wav");

      // Download OGG from Telegram using the files plugin
      const file = await ctx.getFile();
      // hydrateFiles adds .download() at runtime via API transformer
      const downloaded = await (
        file as typeof file & { download(path: string): Promise<string> }
      ).download(oggPath);

      // Set file permissions on downloaded OGG
      await chmod(downloaded, 0o600);

      // Convert OGG to WAV (16kHz mono PCM)
      await execFileAsync(
        config.FFMPEG_PATH,
        ["-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
        { env: filteredEnv },
      );

      // Transcribe with whisper.cpp
      const { stdout } = await execFileAsync(
        config.WHISPER_CLI_PATH!,
        ["-m", config.WHISPER_MODEL_PATH!, "-f", wavPath, "-nt", "-l", "en"],
        { timeout: 30000, env: filteredEnv },
      );

      // Parse and trim transcription
      const transcription = stdout.trim();

      if (!transcription) {
        await ctx.reply("Could not transcribe voice message (empty result).", {
          message_thread_id: threadId,
        });
        return;
      }

      // Generate a key for the pending transcription map
      const msgKey = String(ctx.message.message_id);

      // Store transcription and session name for callback retrieval
      pendingTranscriptions.set(msgKey, {
        text: transcription,
        sessionName: mapping.tmuxSession,
      });

      // Build inline keyboard with Send and Cancel buttons
      const keyboard = new InlineKeyboard()
        .text("Send", `voice-send:${msgKey}`)
        .text("Cancel", `voice-cancel:${msgKey}`);

      // Show transcription with inline buttons
      await ctx.reply(
        `\u{1F3A4} Transcription:\n${transcription}`,
        {
          reply_markup: keyboard,
          message_thread_id: threadId,
        },
      );
    } catch (err: unknown) {
      const errMsg =
        err instanceof Error ? err.message : String(err);
      console.error(
        `[VoiceHandler] ${new Date().toISOString()} Transcription failed:`,
        errMsg,
      );
      await ctx.reply(`Voice transcription failed: ${errMsg}`, {
        message_thread_id: threadId,
      });
    } finally {
      transcriptionInProgress = false;

      // Clean up temp directory
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch((err) => {
          console.error(
            `[VoiceHandler] ${new Date().toISOString()} Failed to clean temp dir:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
    }
  });

  // Callback handler: Send transcription to tmux
  bot.callbackQuery(/^voice-send:(.+)$/, async (ctx) => {
    const match = ctx.match;
    const msgKey = match[1];

    const pending = pendingTranscriptions.get(msgKey);
    if (!pending) {
      await ctx.answerCallbackQuery("Transcription expired or not found.");
      return;
    }

    // Forward text to tmux
    const result = await tmux.sendKeys(pending.sessionName, pending.text);
    if (!result.ok) {
      await ctx.answerCallbackQuery("Failed to send to tmux.");
      return;
    }

    // Clean up the stored transcription
    pendingTranscriptions.delete(msgKey);

    // Edit the message to show it was sent
    await ctx.editMessageText(
      `\u{1F3A4} Transcription (Sent):\n${pending.text}`,
    );
    await ctx.answerCallbackQuery("Sent!");
  });

  // Callback handler: Cancel transcription
  bot.callbackQuery(/^voice-cancel:(.+)$/, async (ctx) => {
    const match = ctx.match;
    const msgKey = match[1];

    // Clean up the stored transcription
    pendingTranscriptions.delete(msgKey);

    // Delete the transcription message
    await ctx.deleteMessage();
    await ctx.answerCallbackQuery("Cancelled.");
  });
}
