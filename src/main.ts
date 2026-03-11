import "dotenv/config";
import { config } from "./config.js";
import { createBot } from "./bot.js";
import { createTerminalBackend } from "./services/terminal-backend-factory.js";
import { createSessionMapper } from "./services/session-mapper.js";
import { startSessionDiscovery } from "./handlers/session-discovery.js";
import { registerCommands } from "./handlers/commands.js";
import { registerMessageHandler } from "./handlers/message-handler.js";
import { createOutputMonitor } from "./services/output-monitor.js";
import { createFileWatcher } from "./services/file-watcher.js";
import { createNotifyServer } from "./services/notify-server.js";
import { createVoiceHandler } from "./services/voice-handler.js";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  // Initialize terminal backend (auto-detects or uses config preference)
  const backend = await createTerminalBackend(config);
  console.log(`[Main] Backend: ${backend.type}`);

  // Initialize services
  const sessionMapper = createSessionMapper();
  await sessionMapper.load((name) => backend.sessionExists(name));

  // Initialize bot
  const bot = createBot();

  // Validate bot token
  const me = await bot.api.getMe();
  await bot.api.setMyCommands([
    { command: "sessions", description: "List all terminal sessions" },
    { command: "stop", description: "Send Ctrl+C to the connected session" },
    { command: "file", description: "Send a file from the project" },
    { command: "tree", description: "Show project directory tree" },
    { command: "disconnect", description: "Disconnect (keeps session running)" },
  ]);
  console.log(`[Main] Bot: @${me.username}`);
  console.log(`[Main] Loaded sessions: ${sessionMapper.listAll().length}`);
  console.log(`[Main] Notify port: ${config.NOTIFY_PORT}`);

  // Create services
  const fileWatcher = createFileWatcher(bot);
  const outputMonitor = createOutputMonitor(bot, backend, sessionMapper, fileWatcher);
  const notifyServer = createNotifyServer(bot, sessionMapper, backend);

  // Register handlers (order matters - commands before general message handler)
  registerCommands(bot, backend, sessionMapper, outputMonitor, fileWatcher);
  createVoiceHandler(bot, backend, sessionMapper);
  registerMessageHandler(bot, backend, sessionMapper);

  // Start notification server
  notifyServer.start();

  // Start session discovery (only for backends that support listing sessions)
  let stopDiscovery = () => {};
  if ("listSessions" in backend) {
    stopDiscovery = startSessionDiscovery(
      bot,
      backend as import("./types/terminal-backend.js").TerminalBackend &
        import("./types/terminal-backend.js").SessionDiscoverable,
      sessionMapper,
      outputMonitor,
      fileWatcher,
    );
  }

  // Start monitoring for existing sessions
  for (const mapping of sessionMapper.listAll()) {
    outputMonitor.start(mapping.sessionId);
    fileWatcher.start(mapping.projectRoot, config.CHAT_ID, mapping.topicId);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Main] Shutting down...");
    bot.stop();
    outputMonitor.stopAll();
    fileWatcher.stopAll();
    notifyServer.stop();
    stopDiscovery();
    sessionMapper.save();
    await backend.dispose();
    // Allow up to 3 seconds for graceful drain, then force exit
    setTimeout(() => process.exit(0), 3000);
  };
  process.once("SIGINT", () => void shutdown());
  if (process.platform !== "win32") {
    process.once("SIGTERM", () => void shutdown());
  }

  // Catch uncaught exceptions
  process.on("uncaughtException", (err) => {
    console.error("[Main] Uncaught:", err);
    void backend.dispose().then(() => process.exit(1));
  });

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
