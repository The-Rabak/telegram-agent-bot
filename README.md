# Telegram Agent Bridge

A locally-run Node.js service that bridges your terminal-based agent CLI sessions (Claude Code, Copilot CLI, etc.) to a Telegram bot. Interact with your running agents from your phone while away from your desk. Works on macOS, Linux, and Windows.

**Core idea:** each terminal session maps to a Telegram forum topic. Messages you send in Telegram are forwarded as keystrokes to the terminal session; output streams back to Telegram in real time.

---

## Features

- **Two-way messaging** — send text, receive streaming output
- **Auto-detect sessions** — new terminal sessions appear as inline button prompts (tmux); create on demand with `/new` (node-pty)
- **Tool approval detection** — `[y/n]` and numbered choice prompts render as tappable buttons
- **File delivery** — `.md` files auto-send to your phone; `/file` and `/tree` on demand
- **Voice messages** — send a voice note, get a transcription confirmation, forward to the terminal
- **Completion hooks** — Claude Code automatically pings you when a task finishes
- **Command autocomplete** — type `/` in Telegram and see all commands

---

## Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Node.js 20+ | Yes | LTS recommended |
| **macOS/Linux:** tmux | Recommended | Auto-detected; `brew install tmux` / `apt install tmux` |
| **Windows:** C++ Build Tools | For node-pty | Visual Studio Build Tools + Python 3 (see [node-pty compilation](#windows-node-pty-compilation)) |
| **All platforms:** node-pty | Fallback | Works everywhere as an alternative backend |
| ffmpeg | Optional | For voice transcription; `brew install ffmpeg` |
| whisper.cpp | Optional | For voice transcription (see [Voice Setup](#voice-setup)) |

---

## Cross-Platform Support

The bridge supports two terminal backends, selected automatically based on your platform:

| Platform | Default Backend | Session Persistence | Session Discovery |
|----------|----------------|--------------------|--------------------|
| macOS | tmux | Yes (survives bot restart) | Auto-detect external sessions |
| Linux | tmux | Yes (survives bot restart) | Auto-detect external sessions |
| Windows | node-pty | No (sessions are ephemeral) | Create via `/new` command |

Override with `TERMINAL_BACKEND=tmux|node-pty|auto` in `.env`.

For detailed setup instructions per platform and tool, see **[Cross-Platform Setup Guide](docs/CROSS-PLATFORM-SETUP.md)**.

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

The bridge uses Telegram **forum topics** (one topic per terminal session), which requires a supergroup.

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

# Optional -- defaults shown
NOTIFY_PORT=3847
SEND_KEYS_DELAY_MS=500
# TERMINAL_BACKEND=auto    # auto | tmux | node-pty
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

### Connecting a Terminal Session

**tmux backend (macOS/Linux):**

1. Create a tmux session: `tmux new -s my-project`
2. The bridge detects it within 10 seconds and sends a message to your Telegram group:

   ```
   New tmux session detected: my-project
   Connect to Telegram?  [Connect] [Ignore]
   ```

3. Tap **Connect** -- a new topic named `my-project` is created in the group

**node-pty backend (Windows / fallback):**

1. Send `/new my-project` in the Telegram group
2. A new terminal session and topic are created immediately
3. The session runs inside the bridge process (no external terminal needed)

### Telegram Commands

Use these inside a connected session topic:

| Command | Description |
|---|---|
| `/sessions` | List all terminal sessions and their connection status |
| `/new [name]` | Create a new terminal session (node-pty backend only) |
| `/stop` | Send Ctrl+C to the connected session |
| `/file <path>` | Send a file from the project as a Telegram document |
| `/tree` | Show the project directory tree (depth 3) |
| `/tree <subdir>` | Show a specific subdirectory |
| `/disconnect` | Disconnect the bridge (tmux sessions keep running; node-pty sessions are terminated) |

### Sending Messages

Type any message in a connected topic -- it's forwarded to the terminal session and Enter is sent. The terminal output streams back as Telegram message edits.

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
4. Tap **Send** to forward the text to the terminal session

---

## Agent Skill (Claude Code)

The `.claude/skills/telegram-bridge/SKILL.md` file teaches Claude Code about the bridge. When the skill is loaded, the agent knows:

- How to send completion notifications via `curl`
- How to request user decisions with action buttons
- How to push files to your phone
- Which Telegram commands you have available

The skill is loaded automatically when Claude Code detects it in the project. No configuration needed beyond having the file present.

---

## Copilot CLI (and any other tool)

The bridge is tool-agnostic -- output streaming, two-way messaging, file watching, and voice messages all work with any CLI running in a terminal session. The only Claude-specific part is the Stop hook that auto-notifies on completion.

For Copilot CLI and other tools, `shell/bridge-helpers.sh` provides equivalent wrappers.

### Install GitHub Copilot CLI

You need the [GitHub CLI](https://cli.github.com) and the Copilot extension:

```bash
# Install GitHub CLI
brew install gh

# Authenticate
gh auth login

# Install the Copilot extension
gh extension install github/gh-copilot

# Verify
gh copilot --version
```

### Source the Shell Helpers

```bash
echo 'source /path/to/cli-agent-telegram-bot/shell/bridge-helpers.sh' >> ~/.zshrc
source ~/.zshrc
```

### Use Copilot via the Bridge

Use `cop` instead of `gh copilot`:

```bash
cop suggest "delete all stopped docker containers"
cop explain "awk '{print $1}' file.txt"
```

When Copilot finishes, you get a ✅ or ❌ notification on Telegram automatically.

### Any Command

Wrap any long-running command with `run-and-notify`:

```bash
run-and-notify npm test
run-and-notify make build
run-and-notify python train.py
```

### Manual Notifications from Shell Scripts

```bash
notify success "Deployment to staging complete"
notify error "Integration tests failed"
notify warning "Disk usage above 90%"
```

### Available Shell Helpers

| Function | Description |
|---|---|
| `cop <args>` | `gh copilot` wrapper — notifies on completion |
| `run-and-notify <cmd>` | Run any command, notify when done |
| `notify <type> <msg>` | Send a custom notification |

---

## Architecture

```
Phone (Telegram App)
    |
    v
Telegram Bot API (long polling)
    |
    v
Local Node.js Service (grammy)
    |
    +-- TerminalBackend (pluggable)
    |     +-- TmuxBackend (macOS/Linux: tmux CLI)
    |     +-- NodePtyBackend (Windows: node-pty)
    |
    +-- OutputMonitor: poll/stream terminal output to Telegram
    +-- FileWatcher: watch .md files, auto-send to Telegram
    +-- VoiceHandler: voice note -> ffmpeg -> whisper -> text
    +-- NotifyServer: HTTP POST localhost:3847/notify
    +-- AuthMiddleware: user ID whitelist
    +-- SessionMapper: terminal sessions <-> Telegram topics
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOT_TOKEN` | Yes | -- | Telegram bot token from @BotFather |
| `ALLOWED_USER_IDS` | Yes | -- | Comma-separated Telegram user IDs |
| `CHAT_ID` | Yes | -- | Supergroup chat ID (negative number) |
| `NOTIFY_PORT` | No | `3847` | Port for the HTTP notification endpoint |
| `SEND_KEYS_DELAY_MS` | No | `500` | Delay (ms) between text and Enter in terminal |
| `TERMINAL_BACKEND` | No | `auto` | Backend selection: `tmux`, `node-pty`, or `auto` |
| `MAX_PTY_SESSIONS` | No | `5` | Max concurrent node-pty sessions |
| `PTY_COLS` | No | `120` | Terminal width for node-pty sessions |
| `PTY_ROWS` | No | `40` | Terminal height for node-pty sessions |
| `PTY_SHELL` | No | (auto) | Override shell for node-pty (e.g., `/bin/zsh`, `pwsh.exe`) |
| `WHISPER_CLI_PATH` | No | -- | Path to `whisper-cli` binary |
| `WHISPER_MODEL_PATH` | No | -- | Path to `ggml-base.en.bin` model file |
| `FFMPEG_PATH` | No | `ffmpeg` | Path to ffmpeg binary |

---

## Session Persistence

Session mappings (terminal session <-> Telegram topic) are persisted to `~/.telegram-agent-bridge/sessions.json` with permissions `0600`.

- **tmux backend:** On restart, the bridge reconciles stored mappings against live tmux sessions, removing any that no longer exist. Sessions survive bot restarts because tmux runs independently.
- **node-pty backend:** Sessions are ephemeral and live inside the bridge process. When the bridge stops, all node-pty sessions are terminated. Use `/new` to create fresh sessions after a restart.

---

## Troubleshooting

**Bot doesn't respond to messages**
- Check `ALLOWED_USER_IDS` contains your Telegram user ID
- Verify the bot is an admin in the group with Manage Topics permission

**No topics created after Connect**
- Confirm the group is a Supergroup (not a regular group)
- Confirm Topics are enabled in Group Settings
- Confirm the bot has the "Manage Topics" admin permission

**Session not detected (tmux backend)**
- The bridge scans for new sessions every 10 seconds
- Ensure the tmux session exists: `tmux ls`
- Check the bridge is running: look for its log output

**Cannot create session (node-pty backend)**
- Use the `/new [name]` command in Telegram to create sessions
- Check that `MAX_PTY_SESSIONS` has not been reached (default: 5)
- If `npm install` failed for node-pty, see [node-pty compilation](#windows-node-pty-compilation) below

**`POST /notify` returns connection refused**
- The bridge isn't running, or it started on a different port
- Check `NOTIFY_PORT` in `.env` matches the curl command

**Voice transcription fails**
- Test ffmpeg: `ffmpeg -version`
- Test whisper: `/path/to/whisper-cli --help`
- Check `WHISPER_CLI_PATH` and `WHISPER_MODEL_PATH` point to valid files
- Voice messages over 60 seconds are rejected

### Windows: node-pty Compilation

node-pty requires native C++ compilation. If `npm install` fails:

1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-studio-cpp-build-tools/) with the "Desktop development with C++" workload
2. Install Python 3 and ensure it is on your PATH
3. Or use the prebuilt alternative: replace `node-pty` with `@homebridge/node-pty-prebuilt-multiarch` in `package.json`

For more detailed platform-specific troubleshooting, see the **[Cross-Platform Setup Guide](docs/CROSS-PLATFORM-SETUP.md)**.
