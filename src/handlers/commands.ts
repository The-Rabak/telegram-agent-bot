import fs from "node:fs";
import path from "node:path";
import { InputFile } from "grammy";
import type { Bot } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TmuxManager } from "../services/tmux-manager.js";
import type { SessionMapper } from "../services/session-mapper.js";
import { EXCLUDED_DIRS } from "../constants.js";

function registerCommands(
  bot: Bot<AppContext>,
  tmux: TmuxManager,
  sessionMapper: SessionMapper,
): void {
  // ── /sessions ──────────────────────────────────────────────────────
  bot.command("sessions", async (ctx) => {
    const result = await tmux.listSessions();

    if (!result.ok) {
      await ctx.reply("Failed to list tmux sessions.", {
        parse_mode: "HTML",
      });
      return;
    }

    const sessions = result.data;

    if (sessions.length === 0) {
      await ctx.reply("No tmux sessions found.", { parse_mode: "HTML" });
      return;
    }

    const lines: string[] = ["<b>tmux Sessions</b>", ""];

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
      await ctx.reply("This topic is not connected to a tmux session.");
      return;
    }
    const result = await tmux.sendInterrupt(mapping.tmuxSession);
    if (result.ok) {
      await ctx.reply(
        `Sent Ctrl+C to session <code>${escapeHtml(mapping.tmuxSession)}</code>`,
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
      await ctx.reply("This topic is not connected to a tmux session.");
      return;
    }

    const filePath = ctx.match?.trim();
    if (!filePath) {
      await ctx.reply("Usage: /file <relative-path>");
      return;
    }

    // Security: resolve and verify containment
    const resolved = path.resolve(mapping.projectRoot, filePath);
    const realPath = await fs.promises.realpath(resolved).catch(() => null);
    const realRoot = await fs.promises
      .realpath(mapping.projectRoot)
      .catch(() => null);

    if (
      !realPath ||
      !realRoot ||
      (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot)
    ) {
      await ctx.reply("Access denied: path is outside the project root.");
      return;
    }

    // Check file size
    const stat = await fs.promises.stat(realPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      await ctx.reply("File not found.");
      return;
    }
    if (stat.size > 50 * 1024 * 1024) {
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
      await ctx.reply("This topic is not connected to a tmux session.");
      return;
    }

    const subdir = ctx.match?.trim();
    const rootDir = subdir
      ? path.resolve(mapping.projectRoot, subdir)
      : mapping.projectRoot;

    // Path containment check for subdir
    if (subdir) {
      const realPath = await fs.promises
        .realpath(rootDir)
        .catch(() => null);
      const realRoot = await fs.promises
        .realpath(mapping.projectRoot)
        .catch(() => null);

      if (
        !realPath ||
        !realRoot ||
        (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot)
      ) {
        await ctx.reply("Access denied: path is outside the project root.");
        return;
      }
    }

    // Verify directory exists
    const dirStat = await fs.promises.stat(rootDir).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      await ctx.reply("Directory not found.");
      return;
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
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export { registerCommands };
