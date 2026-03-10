import "dotenv/config";
import { config } from "./config.js";
import { createBot } from "./bot.js";
import { createTmuxManager } from "./services/tmux-manager.js";
import { createSessionMapper } from "./services/session-mapper.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

async function main() {
  console.log("[Main] Telegram Agent Bridge starting...");

  // Startup validation
  try {
    await execFileAsync("which", ["tmux"]);
  } catch {
    console.error("[Main] tmux is not installed or not on PATH. Exiting.");
    process.exit(1);
  }

  // Check optional dependencies
  let voiceEnabled = false;
  try {
    const ffmpegPath = config.FFMPEG_PATH;
    await execFileAsync("which", [ffmpegPath]);
    if (config.WHISPER_CLI_PATH && config.WHISPER_MODEL_PATH) {
      voiceEnabled = true;
    }
  } catch {
    // ffmpeg not found
  }

  // Initialize services
  const tmux = createTmuxManager();
  const sessionMapper = createSessionMapper();
  await sessionMapper.load((name) => tmux.sessionExists(name));

  // Initialize bot
  const bot = createBot();

  // Validate bot token
  const me = await bot.api.getMe();
  console.log(`[Main] Bot: @${me.username}`);
  console.log(`[Main] Loaded sessions: ${sessionMapper.listAll().length}`);
  console.log(`[Main] Notify port: ${config.NOTIFY_PORT}`);
  console.log(`[Main] Voice: ${voiceEnabled ? "enabled" : "disabled (install ffmpeg + whisper.cpp)"}`);

  // Graceful shutdown
  const shutdown = () => {
    console.log("[Main] Shutting down...");
    bot.stop();
    sessionMapper.save();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Start bot
  await bot.start({
    drop_pending_updates: true,
    onStart: () => console.log("[Main] Bot started. Listening for messages..."),
  });
}

main().catch((err) => {
  console.error("[Main] Fatal error:", err);
  process.exit(1);
});
