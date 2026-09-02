# Roadmap

- [x] Wire the verified FocusCalm/Regul8 CMSN handshake into the app as a real connector
- [x] Add a dedicated Brainwaves page showing decoded EEG live (waveform, spectrum, bands)
- [x] Analyse the desktop Chrome firmware 1.1.6 diagnostic capture and identify the
      retry-session command-id bug
- [x] Restart CMSN command IDs per GATT connection and prioritise the already-paired path
- [x] macOS CoreBluetooth bridge (bridge/macos) streaming the headband to the app over WebSocket
- [x] iOS bridge app (bridge/ios) streaming the headband to MindGuard on the same iPhone
- [ ] Confirm the user can obtain the bridge source on their own machine (repo export/clone) — pasted terminal command fails without it
- [ ] Walk user through cloning the repo on their Mac and running the bridge (Xcode CLT setup)
