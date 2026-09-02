# MindGuard iPhone headband bridge

Same job as the macOS bridge, on the phone: an iOS app owns the Bluetooth link
through CoreBluetooth (which negotiates the bonded, encrypted connection the
FC-11 / Regul8 firmware demands), runs the verified CMSN handshake, decodes the
24-bit samples to microvolts, and republishes them on a WebSocket that MindGuard
consumes like any other EEG source.

```
Headband --BLE(bonded)--> MindGuard Bridge app --ws://127.0.0.1:8787--> Safari
```

## Important: it must be the same iPhone

Safari on **this** phone connects to `127.0.0.1`, which browsers treat as a
secure origin. Streaming to a browser on another device would need `ws://` from
an `https://` page over the LAN, which every browser blocks as mixed content.
So: bridge app and MindGuard both run on the one iPhone, side by side.

## What you need

- An iPhone on iOS 16+
- A Mac with **Xcode** installed (from the Mac App Store) — Apple gives no way
  to build an iOS app without it
- A free Apple ID (a paid developer account is not required; a free-signed app
  works for 7 days at a time before it needs a re-install)
- A USB cable

## Build and install

1. Get this repo onto the Mac: in Lovable use **GitHub → Connect / Export**, then
   `git clone` it locally. The `bridge/` folder does not exist on your Mac until
   you do this — that is the usual reason a pasted command "does nothing".
2. Easiest route, with [XcodeGen](https://github.com/yonaskolb/XcodeGen):
   ```bash
   brew install xcodegen
   cd bridge/ios
   xcodegen generate
   open MindGuardBridge.xcodeproj
   ```
   No XcodeGen? In Xcode choose **File → New → Project → iOS → App**
   (SwiftUI, name `MindGuardBridge`), delete the generated `ContentView.swift`
   and `…App.swift`, drag in the three files from `Sources/`, and copy the keys
   from `Resources/Info.plist` into the target's **Info** tab.
3. Select your iPhone as the run destination.
4. **Signing & Capabilities** → Team → add your Apple ID. Xcode picks a bundle ID
   automatically if `app.mindguard.bridge` is taken.
5. Press ▶. First launch on the phone: **Settings → General → VPN & Device
   Management → trust your developer certificate**.

## Use it

1. Quit the FocusCalm app fully, and power-cycle the headband so it advertises.
2. Open **MindGuard Bridge**, allow Bluetooth, press **Start bridge**.
3. Watch the log: `Found "…" Connecting…` → `ack … result 0` → `EEG streaming`.
4. Tap **Open MindGuard in Safari**, go to **Tools → Live brainwaves**, and in
   the *headband bridge* panel connect to `ws://127.0.0.1:8787`.
5. Confirm the signal is real: blink hard (large deflections), close your eyes
   for 20 s (alpha peak at 8–12 Hz), clench your jaw (broadband EMG).

Keep the bridge app running. `bluetooth-central` background mode keeps the link
alive when you switch to Safari, but iOS may suspend it if the phone is left
idle for a long time — the bridge reconnects and restarts the handshake by
itself when that happens.

## Settings

| Field | Default | Meaning |
| --- | --- | --- |
| Port | `8787` | WebSocket port; change it if something else uses 8787 |
| Name contains | `regul8` | Substring of the advertised name — try `focuscalm` |
| Channel | `AF7` | Analysis electrode the single channel maps to |
| Send pair command first | off | Only enable if the firmware rejects the start command |

## Troubleshooting

- **Nothing found** — the band advertises only while awake and unconnected. Also
  make sure the FocusCalm app is force-quit; it holds the band exclusively.
- **Connects, then drops** — expected on the first attempt while iOS bonds. The
  bridge retries automatically, alternating the pair / skip-pair path.
- **`ack … result` non-zero** — the firmware rejected that command; send me the
  log line and I will adjust the sequence.
- **Streaming in the app but flat trace** — check the channel name matches the
  montage MindGuard expects (`AF7` by default).

## Keeping the implementations in step

`Sources/CMSNCore.swift` is a deliberate copy of the protocol core in
`bridge/macos/MindGuardBridge.swift` (the macOS file stays self-contained so it
can run as a `swift` script). `src/lib/eeg/focuscalm-cmsn.ts` is the third copy.
Any protocol change must land in all three.
