#!/bin/bash
#
# Removes the MindGuard headband bridge background service.
#
set -euo pipefail

LABEL="app.mindguard.bridge"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "${PLIST}"
rm -rf "${HOME}/Library/Application Support/MindGuardBridge"

echo "MindGuard bridge service removed. Logs kept in ~/Library/Logs/MindGuardBridge."
