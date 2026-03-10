---
name: telegram-bridge
description: Send completion notifications and status updates via the Telegram Agent Bridge running on localhost. Use when a major task completes, when communicating progress, or when needing user attention. Triggers on task completion, notification, done, status update, progress.
user-invocable: false
---

# Telegram Agent Bridge

A bridge is running that relays messages between this terminal and the user's Telegram app.

## Session Name

Current tmux session: !`tmux display-message -p '#{session_name}'`

## Send Notifications

Notify the user when you complete a major task:

```bash
curl -s -X POST http://localhost:3847/notify \
  -H 'Content-Type: application/json' \
  -d '{"session": "SESSION_NAME", "type": "success", "message": "Brief description"}'
```

Notification types: `info`, `success`, `warning`, `error`, `progress`, `attention`, `file`.

### Request User Decision

```bash
curl -s -X POST http://localhost:3847/notify \
  -H 'Content-Type: application/json' \
  -d '{"session": "SESSION_NAME", "type": "attention", "message": "Which approach?", "actions": [{"label": "Option A", "value": "A"}, {"label": "Option B", "value": "B"}]}'
```

### Send a File

```bash
curl -s -X POST http://localhost:3847/notify \
  -H 'Content-Type: application/json' \
  -d '{"session": "SESSION_NAME", "type": "file", "message": "Generated report", "file": {"path": "relative/path/to/file"}}'
```

## Rules

- **Only the main orchestrator agent** should send notifications. Sub-agents must NOT notify.
- `.md` files in the project root are auto-delivered to Telegram.
- The user has these Telegram commands: `/stop` (Ctrl+C), `/file <path>`, `/tree`, `/sessions`, `/disconnect`.
