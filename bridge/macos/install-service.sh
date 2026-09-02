#!/bin/bash
#
# Installs the MindGuard headband bridge as a per-user background service.
#
# launchd starts it at login, restarts it if it ever exits, and keeps it
# running while the app (and the browser) are closed, so the headband link is
# owned by the Mac rather than by a Terminal window that has to stay open.
#
#   ./bridge/macos/install-service.sh [--port 8787] [--name regul8]
#                                     [--channel AF7] [--pair]
#
set -euo pipefail

LABEL="app.mindguard.bridge"
PREFIX="${HOME}/Library/Application Support/MindGuardBridge"
BIN="${PREFIX}/mindguard-bridge"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/MindGuardBridge"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/MindGuardBridge.swift"

if [[ ! -f "${SRC}" ]]; then
  echo "Cannot find MindGuardBridge.swift next to this script." >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install the Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

# Everything after the script name is passed straight to the bridge, so the
# service runs with the same flags you would type by hand.
ARGS=("$@")

mkdir -p "${PREFIX}" "${LOG_DIR}" "${HOME}/Library/LaunchAgents"

echo "Building the bridge…"
swiftc -O "${SRC}" -o "${BIN}"

# Stop a previous copy before replacing its job definition.
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true

{
  cat <<PLIST_HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BIN}</string>
PLIST_HEAD
  for arg in ${ARGS[@]+"${ARGS[@]}"}; do
    printf '    <string>%s</string>\n' "${arg}"
  done
  cat <<PLIST_TAIL
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/bridge.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/bridge.err.log</string>
</dict>
</plist>
PLIST_TAIL
} > "${PLIST}"

launchctl bootstrap "gui/$(id -u)" "${PLIST}"
launchctl enable "gui/$(id -u)/${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

cat <<DONE

MindGuard bridge service installed.

  status : launchctl print gui/$(id -u)/${LABEL} | head -20
  logs   : tail -f "${LOG_DIR}/bridge.log"
  stop   : launchctl bootout gui/$(id -u)/${LABEL}
  start  : launchctl bootstrap gui/$(id -u) "${PLIST}"
  remove : ./bridge/macos/uninstall-service.sh

It starts at login and restarts itself if it stops. macOS will ask once for
Bluetooth permission — if no prompt appears, grant it under
System Settings → Privacy & Security → Bluetooth.

The app connects to it at ws://127.0.0.1:8787 whenever you open
Tools → Live brainwaves.
DONE
