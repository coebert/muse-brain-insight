# MindGuard macOS headband bridge

Web Bluetooth cannot ask macOS for a **bonded, encrypted** BLE link. The
FocusCalm / Regul8 FC-11 firmware closes the connection when vendor CMSN
commands arrive on an unencrypted link, which is why the browser reaches GATT
but never receives EEG.

This bridge sidesteps that: a small Swift process owns the radio through
CoreBluetooth (which *does* negotiate the encrypted link), runs the verified
CMSN handshake, decodes the 24-bit samples to microvolts, and republishes them
on a localhost WebSocket that the app consumes like any other EEG source.

```
Headband --BLE(bonded)--> MindGuardBridge.swift --ws://127.0.0.1:8787--> browser
```

## Requirements

- macOS 12 or later
- Xcode Command Line Tools (`xcode-select --install`)
- The headband **not** connected in the FocusCalm app

## Run it

```bash
swift bridge/macos/MindGuardBridge.swift
```

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port <n>` | `8787` | WebSocket port |
| `--name <text>` | `regul8` | Substring of the advertised name to match (try `focuscalm`) |
| `--channel <id>` | `AF7` | Analysis electrode the single channel maps to |
| `--pair` | off | Send the CMSN pair command first (default: skip, the band is already bonded) |

The first run prompts for Bluetooth permission. If it does not, grant it under
**System Settings → Privacy & Security → Bluetooth**.

Then open the app, go to **Tools → Live brainwaves**, and connect to
`ws://127.0.0.1:8787`.

## What the bridge sends

One JSON object per WebSocket text message:

```json
{"type":"hello","device":"Regul8 Headband","firmware":"1.1.6","channels":["AF7"],"sampleRate":250,"unit":"uV"}
{"type":"samples","seq":42,"channels":{"AF7":[12.4,-3.1]}}
{"type":"battery","percent":88}
{"type":"status","state":"connected","reason":""}
{"type":"log","level":"info","message":"→ start EEG stream (id 3, 22 bytes)"}
```

Samples are already in microvolts; the app resamples 250 Hz → 256 Hz and maps
the channel onto the analysis montage.

## Troubleshooting

- **"Bluetooth permission denied"** — grant it in System Settings and rerun.
- **Nothing found** — the band advertises only while awake and unconnected;
  power-cycle it and quit the FocusCalm app.
- **Connects, no EEG** — the bridge restarts the handshake automatically after
  12 s of silence, alternating the pair / skip-pair path. Watch the `log` lines
  in the app panel or on the terminal: an `ack … result 0` means the firmware
  accepted that command.
- **Port in use** — pass `--port 8788` and enter the same URL in the app.

## Run it as a background service (recommended)

Instead of keeping a Terminal window open, install it as a per-user launchd
agent. It starts at login, restarts itself if it ever exits, and keeps the
headband link alive while the app and the browser are closed.

```bash
./bridge/macos/install-service.sh              # defaults
./bridge/macos/install-service.sh --port 8788 --name focuscalm
```

Any flags you pass are baked into the service definition.

| Task | Command |
| --- | --- |
| Status | `launchctl print gui/$(id -u)/app.mindguard.bridge \| head -20` |
| Live logs | `tail -f ~/Library/Logs/MindGuardBridge/bridge.log` |
| Stop | `launchctl bootout gui/$(id -u)/app.mindguard.bridge` |
| Start | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.mindguard.bridge.plist` |
| Restart | `launchctl kickstart -k gui/$(id -u)/app.mindguard.bridge` |
| Remove | `./bridge/macos/uninstall-service.sh` |

The binary lives in `~/Library/Application Support/MindGuardBridge/`. Rerun the
installer after pulling a newer `MindGuardBridge.swift` to rebuild and reload it.

Note that the service holds the headband continuously, so the FocusCalm app
will not be able to connect to the band while it is running. It also means the
app can be closed and reopened at any time: opening **Tools → Live brainwaves**
and connecting simply re-attaches to the already-streaming bridge.

## Build a standalone binary (optional)

```bash
swiftc -O bridge/macos/MindGuardBridge.swift -o /usr/local/bin/mindguard-bridge
mindguard-bridge
```
