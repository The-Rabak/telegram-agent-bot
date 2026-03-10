# Telegram Agent Bridge

A locally-run Node.js service that bridges your tmux-based agent CLI sessions (Claude Code, Copilot CLI, etc.) to a Telegram bot. Interact with your running agents from your phone while away from your desk.

**Core idea:** each tmux session maps to a Telegram forum topic. Messages you send in Telegram are forwarded as keystrokes to the tmux session; terminal output streams back to Telegram in real time.

---

## Features

- **Two-way messaging** — send text, receive streaming output
- **Auto-detect sessions** — new tmux sessions appear as inline button prompts
- **Tool approval detection** — `[y/n]` and numbered choice prompts render as tappable buttons
- **File delivery** — `.md` files auto-send to your phone; `/file` and `/tree` on demand
- **Voice messages** — send a voice note, get a transcription confirmation, forward to tmux
- **Completion hooks** — Claude Code automatically pings you when a task finishes
- **Command autocomplete** — type `/` in Telegram and see all commands

---

## Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Node.js 18+ | Yes | For `util.stripVTControlCharacters` |
| tmux | Yes | `brew install tmux` |
| ffmpeg | Optional | For voice transcription; `brew install ffmpeg` |
| whisper.cpp | Optional | For voice transcription (see [Voice Setup](#voice-setup)) |

---

## Telegram Setup

### 1. Create a Bot via @BotFather

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts (name + username)
3. Copy the **bot token** — looks like `1234567890:ABCDefgh...`

### 2. Get Your Telegram User ID

1. Search for `@userinfobot` in Telegram
2. Send it any message — it replies with your user ID (a number like `123456789`)
3. Keep this — you'll need it for `ALLOWED_USER_IDS`

### 3. Create a Supergroup with Topics

The bridge uses Telegram **forum topics** (one topic per tmux session), which requires a supergroup.

1. Create a new Telegram group (any name, e.g. "Agent Bridge")
2. Open **Group Settings → Edit → Group Type**
3. Make it a **Supergroup** (required for topics)
4. Enable **Topics**: Settings → Edit → Topics → turn on

### 4. Add the Bot as Admin

1. Open your group → **Group Info → Administrators → Add Admin**
2. Search for your bot's username and add it
3. Grant these permissions:
   - **Manage Topics** (required to create session topics)
   - **Send Messages**
   - **Send Media** (for file delivery)
   - **Delete Messages** (for voice transcription cleanup)

### 5. Get the Group Chat ID

The chat ID for a supergroup is a negative number starting with `-100`.

**Method A — via @getidsbot:**
1. Add `@getidsbot` to your group temporarily
2. It will post the group ID
3. Remove the bot when done

**Method B — via the Telegram API:**
1. Add your bot to the group
2. Send any message in the group
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Find `"chat":{"id":` in the response — the negative number is your chat ID

---

## Installation

```bash
git clone <this-repo>
cd telegram-agent-bridge
npm install
```

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required
BOT_TOKEN=1234567890:ABCDefghijklmnopqrstuvwxyz
ALLOWED_USER_IDS=123456789
CHAT_ID=-1001234567890

# Optional — defaults shown
NOTIFY_PORT=3847
SEND_KEYS_DELAY_MS=500
```

---

## Running

```bash
npm start
```

On first run you'll see:

```
[Main] Telegram Agent Bridge starting...
[Main] Bot: @YourBotName
[Main] Loaded sessions: 0
[Main] Notify port: 3847
[Main] Voice: disabled (install ffmpeg + whisper.cpp)
[Main] Bot started. Listening for messages...
```

### Auto-start with launchd (macOS)

To run the bridge automatically on login, create a launchd plist:

```bash
cat > ~/Library/LaunchAgents/com.telegram-agent-bridge.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.telegram-agent-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/telegram-agent-bridge/node_modules/.bin/tsx</string>
    <string>/path/to/telegram-agent-bridge/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/telegram-agent-bridge</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/telegram-agent-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/telegram-agent-bridge.err</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.telegram-agent-bridge.plist
```

---

## Using the Bridge

### Connecting a tmux Session

1. Create a tmux session: `tmux new -s my-project`
2. The bridge detects it within 10 seconds and sends a message to your Telegram group:

   ```
   🔍 New tmux session detected: my-project
   Connect to Telegram?  [Connect] [Ignore]
   ```

3. Tap **Connect** — a new topic named `my-project` is created in the group

### Telegram Commands

Use these inside a connected session topic:

| Command | Description |
|---|---|
| `/sessions` | List all tmux sessions and their connection status |
| `/stop` | Send Ctrl+C to the connected session |
| `/file <path>` | Send a file from the project as a Telegram document |
| `/tree` | Show the project directory tree (depth 3) |
| `/tree <subdir>` | Show a specific subdirectory |
| `/disconnect` | Disconnect the bridge (session keeps running in tmux) |

### Sending Messages

Type any message in a connected topic — it's forwarded to tmux and Enter is sent. The terminal output streams back as Telegram message edits.

### Tool Approval Prompts

When Claude Code (or another agent) asks for confirmation:

```
Allow bash tool? [y/n]
```

The bridge detects this and sends inline buttons **[Yes] [No] [Always Allow]** — tap to respond without typing.

Numbered choice prompts are also detected:

```
Which approach?
1. Rewrite from scratch
2. Incremental refactor
3. Add tests first
```

Renders as three tappable buttons.

### File Auto-Delivery

Any `.md` file created or modified in the project root is automatically sent to the connected topic. This includes brainstorm docs, plans, and reports produced by compound engineering plugins.

---

## Completion Notifications

The bridge exposes a local HTTP endpoint at `localhost:3847/notify`. Agent hooks call this when a task finishes.

### Claude Code Hooks (auto-configured)

If you have `.claude/settings.local.json` in your project (generated by this repo), Claude Code automatically sends a completion notification after every turn:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:3847/notify -H 'Content-Type: application/json' -d '{\"session\": \"'$(tmux display-message -p '#{session_name}')'\", \"type\": \"success\", \"message\": \"Agent turn completed\"}' 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

### Manual Notification

Send any notification via curl:

```bash
# Simple completion
curl -s -X POST http://localhost:3847/notify \
  -H 'Content-Type: application/json' \
  -d '{"session": "my-project", "type": "success", "message": "Tests are passing"}'

# Request a decision
curl -s -X POST http://localhost:3847/notify \
  -H 'Content-Type: application/json' \
  -d '{
    "session": "my-project",
    "type": "attention",
    "message": "Which database should I use?",
    "actions": [
      {"label": "PostgreSQL", "value": "postgres"},
      {"label": "SQLite", "value": "sqlite"}
    ]
  }'

# Send a file
curl -s -X POST http://localhost:3847/notify \
  -H 'Content-Type: application/json' \
  -d '{"session": "my-project", "type": "file", "message": "Report ready", "file": {"path": "docs/report.md"}}'
```

### Notification Types

| Type | Appearance |
|---|---|
| `info` | Plain message |
| `success` | ✅ **Done:** message |
| `warning` | ⚠️ **Warning:** message |
| `error` | ❌ **Error:** message |
| `progress` | `[3/7] Processing files - message` (edits in place) |
| `attention` | Message + inline buttons from `actions` array |
| `file` | File sent as Telegram document |

---

## Voice Setup (Optional)

Voice messages require **ffmpeg** and **whisper.cpp**.

### Install ffmpeg

```bash
brew install ffmpeg
```

### Build whisper.cpp

```bash
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j --config Release

# Download the base English model (~142MB)
sh ./models/download-ggml-model.sh base.en
```

### Configure

Add to your `.env`:

```env
WHISPER_CLI_PATH=/path/to/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL_PATH=/path/to/whisper.cpp/models/ggml-base.en.bin
FFMPEG_PATH=ffmpeg
```

### Using Voice Messages

1. Send a voice note in a connected topic
2. The bridge transcribes it locally (no cloud API, ~1–2s for 10s audio on Apple Silicon)
3. You see the transcription with **[Send]** and **[Cancel]** buttons
4. Tap **Send** to forward the text to tmux

---

## Agent Skill (Claude Code)

The `.claude/skills/telegram-bridge/SKILL.md` file teaches Claude Code about the bridge. When the skill is loaded, the agent knows:

- How to send completion notifications via `curl`
- How to request user decisions with action buttons
- How to push files to your phone
- Which Telegram commands you have available

The skill is loaded automatically when Claude Code detects it in the project. No configuration needed beyond having the file present.

---

## Architecture

```
Phone (Telegram App)
    │
    ▼
Telegram Bot API  ←─── long polling
    │
    ▼
Local Node.js Service
    ├── grammY Bot          — message routing, inline keyboards
    ├── http.createServer   — POST /notify endpoint (port 3847)
    ├── TmuxManager         — execFile wrapper for tmux CLI
    ├── OutputMonitor       — 2s polling, capture-pane diff, streaming edits
    ├── FileWatcher         — fs.watch for .md files, auto-delivery
    ├── VoiceHandler        — OGG → ffmpeg → whisper.cpp → confirm → send
    ├── SessionMapper       — persisted session ↔ topic mappings
    └── AuthMiddleware      — Telegram user ID whitelist
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | Yes | — | Telegram bot token from @BotFather |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated Telegram user IDs |
| `CHAT_ID` | Yes | — | Supergroup chat ID (negative number) |
| `NOTIFY_PORT` | No | `3847` | Port for the HTTP notification endpoint |
| `SEND_KEYS_DELAY_MS` | No | `500` | Delay (ms) between text and Enter in tmux |
| `WHISPER_CLI_PATH` | No | — | Path to `whisper-cli` binary |
| `WHISPER_MODEL_PATH` | No | — | Path to `ggml-base.en.bin` model file |
| `FFMPEG_PATH` | No | `ffmpeg` | Path to ffmpeg binary |

---

## Session Persistence

Session mappings (tmux session ↔ Telegram topic) are persisted to `~/.telegram-agent-bridge/sessions.json` with permissions `0600`. On restart, the bridge reconciles stored mappings against live tmux sessions, removing any that no longer exist.

---

## Troubleshooting

**Bot doesn't respond to messages**
- Check `ALLOWED_USER_IDS` contains your Telegram user ID
- Verify the bot is an admin in the group with Manage Topics permission

**No topics created after Connect**
- Confirm the group is a Supergroup (not a regular group)
- Confirm Topics are enabled in Group Settings
- Confirm the bot has the "Manage Topics" admin permission

**Session not detected**
- The bridge scans for new sessions every 10 seconds
- Ensure the tmux session exists: `tmux ls`
- Check the bridge is running: look for its log output

**`POST /notify` returns connection refused**
- The bridge isn't running, or it started on a different port
- Check `NOTIFY_PORT` in `.env` matches the curl command

**Voice transcription fails**
- Test ffmpeg: `ffmpeg -version`
- Test whisper: `/path/to/whisper-cli --help`
- Check `WHISPER_CLI_PATH` and `WHISPER_MODEL_PATH` point to valid files
- Voice messages over 60 seconds are rejected
