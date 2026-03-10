import { Bot, GrammyError, InlineKeyboard } from "grammy";
import type { AppContext } from "../types/context.js";
import type { TmuxManager } from "./tmux-manager.js";
import type { SessionMapper } from "./session-mapper.js";
import { config } from "../config.js";
import { escapeHtml } from "../utils.js";

const POLL_INTERVAL_MS = 2000;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_DEBOUNCE_MULTIPLIER = 5;
const DEBOUNCE_DECAY_RATE = 0.8;

const TOOL_APPROVAL_PATTERNS = [
  /Allow .+ tool\?\s*\[y\/n/i,
  /Do you want to proceed\?\s*\(y\/n\)/i,
  /\?\s*\[Y\/n\]/i,
  /\?\s*\[y\/N\]/i,
];

const NUMBERED_CHOICE_PATTERN = /^\s*(\d+)\.\s+(.+)/;
const PRE_TAG_OVERHEAD = 11; // "<pre></pre>".length

/** Collapse excessive trailing blank lines from tmux captures to at most one. */
function stripTrailingBlanks(text: string): string {
  return text.replace(/\n{3,}$/g, "\n");
}

interface SessionState {
  previousCapture: string;
  currentMessageId: number | null;
  accumulatedContent: string;
  debounceMultiplier: number;
  lastApprovalPromptSent: boolean;
  lastChoicePromptSent: boolean;
  pollsSinceLastEdit: number;
}

function createDefaultSessionState(): SessionState {
  return {
    previousCapture: "",
    currentMessageId: null,
    accumulatedContent: "",
    debounceMultiplier: 1,
    lastApprovalPromptSent: false,
    lastChoicePromptSent: false,
    pollsSinceLastEdit: 0,
  };
}

/**
 * Compute the "new" lines by comparing previous and current captures.
 * Uses a tail-diff approach: find the first differing line, return everything from there.
 */
function computeNewContent(previous: string, current: string): string {
  const prevLines = previous.split("\n");
  const currLines = current.split("\n");

  let diffIndex = 0;
  const minLen = Math.min(prevLines.length, currLines.length);

  for (let i = 0; i < minLen; i++) {
    if (prevLines[i] !== currLines[i]) {
      break;
    }
    diffIndex = i + 1;
  }

  // If all common lines match and current has more lines, new content starts after common
  // If a line differs, new content starts at that line
  const newLines = currLines.slice(diffIndex);
  return newLines.join("\n");
}

function detectToolApproval(content: string): boolean {
  return TOOL_APPROVAL_PATTERNS.some((pattern) => pattern.test(content));
}

function detectNumberedChoices(content: string): { label: string; value: string }[] | null {
  const lines = content.split("\n");
  const choices: { label: string; value: string }[] = [];
  const MAX_GAP = 3; // Allow up to 3 non-numbered lines between items (wrapped descriptions)
  let gap = 0;

  // Scan from the bottom up to find the most recent set of numbered options
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    const match = line.match(NUMBERED_CHOICE_PATTERN);
    if (match) {
      choices.unshift({ label: `${match[1]}. ${match[2].trim()}`, value: match[1] });
      gap = 0;
    } else if (choices.length >= 2) {
      gap++;
      if (gap > MAX_GAP) {
        // Too many non-numbered lines in a row — stop collecting
        break;
      }
    } else {
      // Not enough numbered items found yet, reset
      choices.length = 0;
      gap = 0;
    }
  }

  return choices.length >= 2 ? choices : null;
}

function createOutputMonitor(
  bot: Bot<AppContext>,
  tmux: TmuxManager,
  sessionMapper: SessionMapper,
  fileWatcher?: { stop(projectRoot: string): void },
) {
  const activeSessions = new Set<string>();
  const sessionStates = new Map<string, SessionState>();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function getOrCreateState(sessionName: string): SessionState {
    let state = sessionStates.get(sessionName);
    if (!state) {
      state = createDefaultSessionState();
      sessionStates.set(sessionName, state);
    }
    return state;
  }

  async function sendOrEditMessage(
    sessionName: string,
    state: SessionState,
    content: string,
    topicId: number,
  ): Promise<void> {
    // Respect debounce multiplier: only edit every N polls
    state.pollsSinceLastEdit++;
    if (state.pollsSinceLastEdit < state.debounceMultiplier) {
      // Accumulate but don't send yet
      return;
    }
    state.pollsSinceLastEdit = 0;

    const chatId = config.CHAT_ID;

    // Strip trailing blanks and escape HTML before formatting
    let textToSend = escapeHtml(stripTrailingBlanks(content));

    // Truncate to fit within Telegram limits, accounting for <pre></pre> wrapper
    const maxContent = MAX_MESSAGE_LENGTH - PRE_TAG_OVERHEAD;
    if (textToSend.length > maxContent) {
      textToSend = textToSend.slice(-maxContent);
    }

    if (!textToSend.trim()) return;

    // Wrap in <pre> for monospace rendering with preserved whitespace
    textToSend = `<pre>${textToSend}</pre>`;

    try {
      if (state.currentMessageId === null) {
        // Send a new message
        const sent = await bot.api.sendMessage(chatId, textToSend, {
          message_thread_id: topicId,
        });
        state.currentMessageId = sent.message_id;

        // Successful send: decay debounce multiplier
        if (state.debounceMultiplier > 1) {
          state.debounceMultiplier = Math.max(
            1,
            state.debounceMultiplier * DEBOUNCE_DECAY_RATE,
          );
        }
      } else {
        // Edit existing message
        await bot.api.editMessageText(
          chatId,
          state.currentMessageId,
          textToSend,
        );

        // Successful edit: decay debounce multiplier
        if (state.debounceMultiplier > 1) {
          state.debounceMultiplier = Math.max(
            1,
            state.debounceMultiplier * DEBOUNCE_DECAY_RATE,
          );
        }
      }
    } catch (err: unknown) {
      if (err instanceof GrammyError && err.error_code === 429) {
        // Rate limited: increase debounce multiplier
        state.debounceMultiplier = Math.min(
          MAX_DEBOUNCE_MULTIPLIER,
          state.debounceMultiplier * 2,
        );
        console.warn(
          `[OutputMonitor] Rate limited for session "${sessionName}", debounce multiplier now ${state.debounceMultiplier}`,
        );
      } else if (
        err instanceof GrammyError &&
        err.description.includes("message is not modified")
      ) {
        // Content identical to existing message, silently ignore
      } else {
        console.error(
          `[OutputMonitor] Failed to send/edit message for session "${sessionName}":`,
          err instanceof Error ? err.message : err,
        );
        // If editing failed for another reason (message deleted, etc.), reset to send new
        if (state.currentMessageId !== null) {
          state.currentMessageId = null;
        }
      }
    }
  }

  async function sendApprovalPrompt(
    sessionName: string,
    topicId: number,
  ): Promise<void> {
    const chatId = config.CHAT_ID;

    const keyboard = new InlineKeyboard()
      .text("Yes", `approval:${sessionName}:yes`)
      .text("No", `approval:${sessionName}:no`)
      .text("Always Allow", `approval:${sessionName}:always`);

    try {
      await bot.api.sendMessage(
        chatId,
        "A tool is requesting approval:",
        {
          message_thread_id: topicId,
          reply_markup: keyboard,
        },
      );
    } catch (err: unknown) {
      console.error(
        `[OutputMonitor] Failed to send approval prompt for session "${sessionName}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async function sendChoicePrompt(
    sessionName: string,
    topicId: number,
    choices: { label: string; value: string }[],
  ): Promise<void> {
    const chatId = config.CHAT_ID;
    const keyboard = new InlineKeyboard();

    // Add each choice as a button (max 4 per row, use rows for readability)
    for (const choice of choices.slice(0, 10)) { // Cap at 10 buttons
      keyboard.text(choice.label.slice(0, 50), `approval:${sessionName}:${choice.value}`);
      keyboard.row();
    }

    try {
      await bot.api.sendMessage(
        chatId,
        "Select an option:",
        {
          message_thread_id: topicId,
          reply_markup: keyboard,
        },
      );
    } catch (err: unknown) {
      console.error(
        `[OutputMonitor] Failed to send choice prompt for "${sessionName}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  async function pollSession(sessionName: string): Promise<void> {
    const mapping = sessionMapper.getBySession(sessionName);
    if (!mapping) {
      // Mapping was removed externally, stop monitoring
      activeSessions.delete(sessionName);
      sessionStates.delete(sessionName);
      return;
    }

    const state = getOrCreateState(sessionName);
    const captureResult = await tmux.capturePane(sessionName);

    if (!captureResult.ok) {
      // Session likely died -- notify user and clean up
      console.warn(
        `[OutputMonitor] Capture failed for session "${sessionName}": ${captureResult.error.message}`,
      );

      try {
        await bot.api.sendMessage(
          config.CHAT_ID,
          `Session "${sessionName}" is no longer available. It may have been closed.`,
          { message_thread_id: mapping.topicId },
        );
      } catch {
        // Best effort notification
      }

      // Stop file watcher for this session's project root
      if (mapping) {
        fileWatcher?.stop(mapping.projectRoot);
      }

      activeSessions.delete(sessionName);
      sessionStates.delete(sessionName);
      sessionMapper.remove(sessionName);
      return;
    }

    const currentCapture = captureResult.data;

    // Skip if nothing changed
    if (currentCapture === state.previousCapture) {
      return;
    }

    const newContent = computeNewContent(state.previousCapture, currentCapture);
    state.previousCapture = currentCapture;

    if (!newContent.trim()) return;

    // Check for tool approval patterns in the full current capture
    const hasApprovalPrompt = detectToolApproval(currentCapture);

    if (hasApprovalPrompt && !state.lastApprovalPromptSent) {
      state.lastApprovalPromptSent = true;
      await sendApprovalPrompt(sessionName, mapping.topicId);
    } else if (!hasApprovalPrompt) {
      state.lastApprovalPromptSent = false;
    }

    // Check for numbered choice patterns
    if (!hasApprovalPrompt) {
      const choices = detectNumberedChoices(currentCapture);
      if (choices && !state.lastChoicePromptSent) {
        state.lastChoicePromptSent = true;
        await sendChoicePrompt(sessionName, mapping.topicId, choices);
      } else if (!choices) {
        state.lastChoicePromptSent = false;
      }
    }

    // Accumulate content
    if (state.accumulatedContent) {
      state.accumulatedContent += "\n" + newContent;
    } else {
      state.accumulatedContent = newContent;
    }

    // If accumulated content exceeds max length, start a new message
    if (state.accumulatedContent.length > MAX_MESSAGE_LENGTH) {
      state.currentMessageId = null;
      // Take only the tail that fits
      state.accumulatedContent = state.accumulatedContent.slice(
        -MAX_MESSAGE_LENGTH,
      );
    }

    await sendOrEditMessage(
      sessionName,
      state,
      state.accumulatedContent,
      mapping.topicId,
    );
  }

  async function pollAll(): Promise<void> {
    for (const sessionName of activeSessions) {
      try {
        await pollSession(sessionName);
      } catch (err: unknown) {
        console.error(
          `[OutputMonitor] Unexpected error polling session "${sessionName}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  function registerCallbackHandlers(): void {
    bot.callbackQuery(/^approval:([^:]+):(.+)$/, async (ctx) => {
      const match = ctx.callbackQuery.data.match(
        /^approval:([^:]+):(.+)$/,
      );
      if (!match) return;

      const sessionName = match[1];
      const value = match[2];

      // Map known words to single chars, otherwise send as-is
      const keystrokeMap: Record<string, string> = { yes: "y", no: "n", always: "a" };
      const keystroke = keystrokeMap[value] ?? value;

      const result = await tmux.sendKeysRaw(sessionName, keystroke);

      if (result.ok) {
        await ctx.answerCallbackQuery({ text: `Sent "${keystroke}" to session` });
      } else {
        await ctx.answerCallbackQuery({
          text: `Failed: ${result.error.message}`,
        });
      }

      // Remove the inline keyboard after the button is pressed
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        // Best effort: message may have been deleted
      }
    });
  }

  function start(sessionName: string): void {
    activeSessions.add(sessionName);
    getOrCreateState(sessionName);

    // Start the interval if not already running
    if (intervalId === null) {
      intervalId = setInterval(() => {
        void pollAll();
      }, POLL_INTERVAL_MS);
    }
  }

  function stop(sessionName: string): void {
    activeSessions.delete(sessionName);
    sessionStates.delete(sessionName);

    // If no more active sessions, clear the interval
    if (activeSessions.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function stopAll(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    activeSessions.clear();
    sessionStates.clear();
  }

  // Register callback handlers immediately
  registerCallbackHandlers();

  return {
    start,
    stop,
    stopAll,
  };
}

type OutputMonitor = ReturnType<typeof createOutputMonitor>;

export { createOutputMonitor };
export type { OutputMonitor };
