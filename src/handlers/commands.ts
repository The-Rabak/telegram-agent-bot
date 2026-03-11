import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TerminalBackend, SessionDiscoverable } from "../types/terminal-backend.js";
import type { SessionMapper } from "../services/session-mapper.js";
import type { OutputMonitor } from "../services/output-monitor.js";
import type { FileWatcher } from "../services/file-watcher.js";
import { EXCLUDED_DIRS } from "../constants.js";
import { config } from "../config.js";
import { escapeHtml, resolveSecurePath, resolveSecureDir } from "../utils.js";

function isDiscoverable(b: TerminalBackend): b is TerminalBackend & SessionDiscoverable {
  return typeof (b as unknown as SessionDiscoverable).listSessions === "function";
}

function registerCommands(
  bot: Bot<AppContext>,
  backend: TerminalBackend,
  sessionMapper: SessionMapper,
  outputMonitor: OutputMonitor,
  fileWatcher: FileWatcher,
): void {
  // ── /sessions ──────────────────────────────────────────────────────
  bot.command("sessions", async (ctx) => {
    if (!isDiscoverable(backend)) {
      // For node-pty, list only the sessions we know about
      const all = sessionMapper.listAll();
      if (all.length === 0) {
        await ctx.reply("No terminal sessions. Use /new to create one.", { parse_mode: "HTML" });
        return;
      }
      const lines: string[] = ["<b>Terminal Sessions</b>", ""];
      for (const mapping of all) {
        lines.push(`<code>${escapeHtml(mapping.sessionId)}</code>`);
        lines.push(`  \u2705 Connected (topic #${mapping.topicId})`);
        lines.push("");
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    const result = await backend.listSessions();

    if (!result.ok) {
      await ctx.reply("Failed to list terminal sessions.", {
        parse_mode: "HTML",
      });
      return;
    }

    const sessions = result.data;

    if (sessions.length === 0) {
      await ctx.reply("No terminal sessions found.", { parse_mode: "HTML" });
      return;
    }

    const lines: string[] = ["<b>Terminal Sessions</b>", ""];

    for (const session of sessions) {
      const status = session.attached ? "attached" : "detached";
      const mapping = sessionMapper.getBySession(session.name);

      lines.push(
        `<code>${escapeHtml(session.name)}</code> - ${status}`,
      );

      if (mapping) {
        lines.push(`  \u2705 Connected (topic #${mapping.topicId})`);
      } else {
        lines.push(`  \u2B1C Not connected`);
      }

      lines.push("");
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /stop ──────────────────────────────────────────────────────────
  bot.command("stop", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Use /stop in a connected session topic.");
      return;
    }
    const mapping = sessionMapper.getByTopic(threadId);
    if (!mapping) {
      await ctx.reply("This topic is not connected to a terminal session.");
      return;
    }
    const result = await backend.sendInterrupt(mapping.sessionId);
    if (result.ok) {
      await ctx.reply(
        `Sent Ctrl+C to session <code>${escapeHtml(mapping.sessionId)}</code>`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(`Failed: ${result.error.message}`);
    }
  });

  // ── /file ──────────────────────────────────────────────────────────
  bot.command("file", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Use /file in a connected session topic.");
      return;
    }
    const mapping = sessionMapper.getByTopic(threadId);
    if (!mapping) {
      await ctx.reply("This topic is not connected to a terminal session.");
      return;
    }

    const filePath = ctx.match?.trim();
    if (!filePath) {
      await ctx.reply("Usage: /file <relative-path>");
      return;
    }

    // Security: resolve and verify containment
    const realPath = await resolveSecurePath(filePath, mapping.projectRoot);
    if (!realPath) {
      await ctx.reply("Access denied or file not found.");
      return;
    }

    // Check file size
    const fileStat = await fs.promises.stat(realPath).catch(() => null);
    if (!fileStat) {
      await ctx.reply("File not found.");
      return;
    }
    if (fileStat.size > 50 * 1024 * 1024) {
      await ctx.reply("File exceeds 50MB Telegram limit.");
      return;
    }

    // Stream file
    const { createReadStream } = await import("node:fs");
    await ctx.replyWithDocument(
      new InputFile(createReadStream(realPath), path.basename(realPath)),
    );
  });

  // ── /tree ──────────────────────────────────────────────────────────
  bot.command("tree", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Use /tree in a connected session topic.");
      return;
    }
    const mapping = sessionMapper.getByTopic(threadId);
    if (!mapping) {
      await ctx.reply("This topic is not connected to a terminal session.");
      return;
    }

    const subdir = ctx.match?.trim();
    let rootDir: string;

    if (subdir) {
      const secureDir = await resolveSecureDir(subdir, mapping.projectRoot);
      if (!secureDir) {
        await ctx.reply("Access denied or directory not found.");
        return;
      }
      rootDir = secureDir;
    } else {
      rootDir = mapping.projectRoot;
    }

    // Build tree
    function buildTree(dir: string, prefix: string, depth: number): string {
      if (depth > 3) {
        return prefix + "...\n";
      }

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return prefix + "(permission denied)\n";
      }

      // Filter excluded dirs and sort
      entries = entries
        .filter((e) => !EXCLUDED_DIRS.has(e.name))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      let result = "";

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";
        const childPrefix = isLast ? "    " : "\u2502   ";

        if (entry.isDirectory()) {
          result += prefix + connector + entry.name + "/\n";
          result += buildTree(
            path.join(dir, entry.name),
            prefix + childPrefix,
            depth + 1,
          );
        } else {
          result += prefix + connector + entry.name + "\n";
        }
      }

      return result;
    }

    const rootName = path.basename(rootDir);
    let tree = rootName + "/\n" + buildTree(rootDir, "", 0);

    if (tree.length > 4000) {
      tree =
        tree.slice(0, 4000) + "\n... (truncated, use /tree <subdir>)";
    }

    await ctx.reply(`<pre>${escapeHtml(tree)}</pre>`, {
      parse_mode: "HTML",
    });
  });

  // ── /disconnect ──────────────────────────────────────────────────
  bot.command("disconnect", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    if (!threadId) {
      await ctx.reply("Use /disconnect in a connected session topic.");
      return;
    }
    const mapping = sessionMapper.getByTopic(threadId);
    if (!mapping) {
      await ctx.reply("This topic is not connected.");
      return;
    }

    outputMonitor.stop(mapping.sessionId);
    fileWatcher.stop(mapping.projectRoot);

    // For node-pty: destroy the session (kills the PTY process)
    if (backend.type === "node-pty") {
      await backend.destroySession(mapping.sessionId);
      sessionMapper.remove(mapping.sessionId);
      await ctx.reply(
        `Session <code>${escapeHtml(mapping.sessionId)}</code> terminated.`,
        { parse_mode: "HTML" },
      );
    } else {
      // For tmux: just disconnect (session keeps running)
      sessionMapper.remove(mapping.sessionId);
      await ctx.reply(
        `Disconnected from session <code>${escapeHtml(mapping.sessionId)}</code>. The terminal session is still running.`,
        { parse_mode: "HTML" },
      );
    }

    try {
      await bot.api.closeForumTopic(config.CHAT_ID, threadId);
    } catch {
      // May not have permission
    }
  });

  // ── /new ────────────────────────────────────────────────────────
  bot.command("new", async (ctx) => {
    // Only available when backend supports session creation (node-pty)
    if (backend.type === "tmux") {
      await ctx.reply("Sessions are discovered automatically. Start a terminal session and it will appear here.");
      return;
    }

    // Parse name from command args
    const name = ctx.match?.trim() || `pty-${Date.now()}`;

    // Create session
    const result = await backend.createSession({ id: name });
    if (!result.ok) {
      await ctx.reply(`Failed to create session: ${result.error.message}`);
      return;
    }

    // Create forum topic
    const topic = await bot.api.createForumTopic(config.CHAT_ID, name);

    // Get working directory
    const dirResult = await backend.getPaneWorkingDir(name);
    const workingDir = dirResult.ok ? dirResult.data : homedir();

    // Add to session mapper
    sessionMapper.add(name, topic.message_thread_id, workingDir, "node-pty");

    // Start monitoring
    outputMonitor.start(name);
    fileWatcher.start(workingDir, config.CHAT_ID, topic.message_thread_id);

    await bot.api.sendMessage(
      config.CHAT_ID,
      `Created terminal session <code>${escapeHtml(name)}</code>\nWorking directory: <code>${escapeHtml(workingDir)}</code>`,
      {
        parse_mode: "HTML",
        message_thread_id: topic.message_thread_id,
      },
    );
  });
}

export { registerCommands };
