#!/usr/bin/env bash
# bridge-helpers.sh
#
# Shell helpers for the Telegram Agent Bridge.
# Adds notification support for CLI tools that don't have a native hook system.
#
# Install: add this to your .zshrc or .bashrc:
#   source /path/to/telegram-agent-bridge/shell/bridge-helpers.sh

# ---------------------------------------------------------------------------
# Internal helper: send a notification to the bridge (silently, non-blocking)
# ---------------------------------------------------------------------------
_bridge_notify() {
  local type="$1"
  local message="$2"
  local session
  session=$(tmux display-message -p '#{session_name}' 2>/dev/null) || return 0
  [[ -z "$session" ]] && return 0

  curl -s -X POST http://localhost:3847/notify \
    -H 'Content-Type: application/json' \
    -d "{\"session\": \"$session\", \"type\": \"$type\", \"message\": \"$message\"}" \
    2>/dev/null || true
}

# ---------------------------------------------------------------------------
# cop — GitHub Copilot CLI wrapper
#
# Usage: cop <copilot args>
#   e.g. cop suggest "delete all docker containers"
#        cop explain "what does this command do: awk '{print $1}'"
# ---------------------------------------------------------------------------
cop() {
  gh copilot "$@"
  local exit_code=$?
  if [[ $exit_code -eq 0 ]]; then
    _bridge_notify "success" "Copilot finished"
  else
    _bridge_notify "error" "Copilot exited with code $exit_code"
  fi
  return $exit_code
}

# ---------------------------------------------------------------------------
# notify — send a custom notification from any shell script or command
#
# Usage: notify <type> <message>
#   e.g. notify success "Build complete"
#        notify error "Tests failed"
#        notify info "Deployment started"
#
# Types: info, success, warning, error, progress, attention, file
# ---------------------------------------------------------------------------
notify() {
  local type="${1:-info}"
  local message="${2:-}"

  if [[ -z "$message" ]]; then
    echo "Usage: notify <type> <message>" >&2
    echo "Types: info, success, warning, error, progress, attention, file" >&2
    return 1
  fi

  _bridge_notify "$type" "$message"
}

# ---------------------------------------------------------------------------
# run-and-notify — run any command and notify when it finishes
#
# Usage: run-and-notify <command> [args...]
#   e.g. run-and-notify npm test
#        run-and-notify make build
#        run-and-notify python train.py
# ---------------------------------------------------------------------------
run-and-notify() {
  if [[ $# -eq 0 ]]; then
    echo "Usage: run-and-notify <command> [args...]" >&2
    return 1
  fi

  local cmd="$*"
  "$@"
  local exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    _bridge_notify "success" "'$cmd' finished successfully"
  else
    _bridge_notify "error" "'$cmd' failed (exit $exit_code)"
  fi

  return $exit_code
}
