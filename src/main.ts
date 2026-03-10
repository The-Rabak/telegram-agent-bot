import "dotenv/config";
import { config } from "./config.js";
import { createBot } from "./bot.js";
import { createTmuxManager } from "./services/tmux-manager.js";
import { createSessionMapper } from "./services/session-mapper.js";
import { startSessionDiscovery } from "./handlers/session-discovery.js";
import { registerCommands } from "./handlers/commands.js";
import { registerMessageHandler } from "./handlers/message-handler.js";
import { createOutputMonitor } from "./services/output-monitor.js";
import { createFileWatcher } from "./services/file-watcher.js";
import { createNotifyServer } from "./services/notify-server.js";
import { createVoiceHandler } from "./services/voice-handler.js";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFileCb);

// Clean up orphaned temp files from previous crashes
async function cleanupOrphanedTempFiles() {
  try {
    const tmpDir = tmpdir();
    const entries = await readdir(tmpDir);
    const orphans = entries.filter((e) => e.startsWith("tg-voice-"));
    for (const orphan of orphans) {
      await rm(join(tmpDir, orphan), { recursive: true, force: true }).catch(
        () => {},
      );
    }
    if (orphans.length > 0) {
      console.log(
        `[Main] Cleaned up ${orphans.length} orphaned temp directories`,
      );
    }
  } catch {
    // Ignore cleanup errors
  }
}

async function main() {
  console.log("[Main] Telegram Agent Bridge starting...");

  // Clean up orphaned temp files from previous crashes
  await cleanupOrphanedTempFiles();

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
  console.log(
    `[Main] Voice: ${voiceEnabled ? "enabled" : "disabled (install ffmpeg + whisper.cpp)"}`,
  );

  // Create services
  const outputMonitor = createOutputMonitor(bot, tmux, sessionMapper);
  const fileWatcher = createFileWatcher(bot);
  const notifyServer = createNotifyServer(bot, sessionMapper, tmux);

  // Register handlers (order matters - commands before general message handler)
  registerCommands(bot, tmux, sessionMapper, outputMonitor, fileWatcher);
  createVoiceHandler(bot, tmux, sessionMapper);
  registerMessageHandler(bot, tmux, sessionMapper);

  // Start notification server
  notifyServer.start();

  // Start session discovery (pass monitors so newly connected sessions auto-start)
  const stopDiscovery = startSessionDiscovery(
    bot,
    tmux,
    sessionMapper,
    outputMonitor,
    fileWatcher,
  );

  // Start monitoring for existing sessions
  for (const mapping of sessionMapper.listAll()) {
    outputMonitor.start(mapping.tmuxSession);
    fileWatcher.start(mapping.projectRoot, config.CHAT_ID, mapping.topicId);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("[Main] Shutting down...");
    bot.stop();
    outputMonitor.stopAll();
    fileWatcher.stopAll();
    notifyServer.stop();
    stopDiscovery();
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
