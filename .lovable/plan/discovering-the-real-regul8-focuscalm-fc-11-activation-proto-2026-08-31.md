# Discovering the real Regul8 / FocusCalm FC-11 activation protocol

## Conclusion

Yes—there is a materially better approach than trying more command variants in MindGuard: capture or recover the exact Bluetooth exchange used by the official FocusCalm app during a successful session.

The current MindGuard probe correctly finds the FC-11 service and subscribes to its notification channel, but its `BRNC` framing, pairing payload, AFE command and START command come from BrainCo’s OxyZen/ZenLite family rather than verified FC-11 traffic. Reordering those same assumed commands is unlikely to resolve a private handshake.

The next work should therefore be evidence-led and should answer two separate questions:

1. What exact pairing/authentication/start exchange does FC-11 firmware 1.1.6 require?
2. Does this retail firmware transmit raw EEG, or only proprietary derived metrics?

## Recommended route

### 1. Recover the official app implementation

Obtain the current official FocusCalm Android package (`tech.brainco.focuscalm`) through a legitimate installation/account and inspect it on the PC or Mac using JADX, apktool and, where needed, Ghidra.

Search for:

- the observed FC-11 UUID block (`0D740001/2/3…`),
- all writes to the FC-11 command characteristic,
- pairing identity construction and persisted bond/session values,
- command enums and protobuf descriptors,
- challenge/response, encryption, signatures or per-device keys,
- native libraries that prepare commands or decode notifications,
- sample-rate, channel count, ADC scaling and raw-sample parsing.

This can reveal a fixed activation sequence directly. If activation is challenge-based, it can reveal the algorithm rather than producing a one-session byte string that cannot be reused.

### 2. Capture a known-good official FocusCalm session

Use the official app to make one successful connection while recording Bluetooth traffic. Capture a clean sequence with the band off the charger and initially disconnected:

```text
Band off → capture starts → band on → app connects → app starts a session
→ wait for live readings → stop session → disconnect → capture stops
```

Available routes with the equipment identified:

- **Mac + iPhone:** use Apple’s Bluetooth logging profile/PacketLogger workflow and collect the Bluetooth sysdiagnose trace. This is the first practical route with existing equipment.
- **Mac or PC + BLE sniffer:** if the iPhone log does not expose ATT values, use an nRF52840 USB dongle with Nordic’s BLE sniffer and Wireshark. This is the most reliable hardware-assisted route, though reconnecting to an already encrypted bond may require deleting the bond and capturing from initial pairing.
- **Android HCI snoop capture:** if an Android phone can be borrowed, this is generally the simplest route because Android can record host-side GATT writes and notifications directly. It is optional, not assumed available.

The capture must include ATT writes, write mode, characteristic UUID, ordering, timing, notifications and connection/bonding events. Sensitive account/network traffic is unnecessary and should not be retained.

### 3. Correlate static and live evidence

Build a chronological protocol transcript from the capture and compare every official-app write with MindGuard’s current sequence:

- exact characteristic and write-with/without-response mode,
- complete bytes and fragmentation boundaries,
- delay and acknowledgement after each command,
- whether a challenge arrives before authentication,
- whether identity is a BLE ID, app UUID, account/device token or derived secret,
- command that starts sustained notifications,
- packet rate and payload evolution once the session begins.

A repeated second capture should distinguish constants from session-specific nonces or tokens. No command should be promoted into MindGuard based on a single unexplained capture.

### 4. Add an offline FC-11 protocol-analysis path

Extend the existing diagnostic/replay tooling to accept a sanitised ATT transcript exported from Wireshark/PacketLogger and produce:

- ordered read/write/notify events,
- request-to-response timing and byte diffs,
- `BRNC` frame/CRC validation where applicable,
- a generic protobuf field census rather than assuming OxyZen field paths,
- candidate acknowledgement fields and changing session values,
- notification cadence, likely sample blocks and measured sample rate.

Keep imported captures local and temporary. Redact phone identifiers, account tokens and unrelated traffic before they enter app diagnostics or fixtures.

### 5. Implement the verified FC-11 protocol separately

Once the evidence is repeatable, create a firmware-scoped FC-11 transport rather than modifying the OxyZen decoder globally:

- explicit state machine for subscribe, authenticate, configure AFE and start,
- exact write semantics and response requirements,
- timeout/retry behavior based on observed timing,
- verified response/error parsing,
- explicit failure when firmware or authentication is unsupported,
- exact sample schema, rate and scaling only if raw EEG is confirmed.

If the app uses a private dynamic credential or licensed SDK secret, do not embed or bypass it. Seek official BrainCo/FocusCalm SDK access instead. If captures show only processed focus/calm metrics and no raw waveform, report that the retail firmware does not provide the data MindGuard requires rather than manufacturing a decoder.

### 6. Validate on the physical headband

Require all of the following before calling the connection solved:

- two fresh starts and one validation/reconnect path,
- first notification within the observed official-app range,
- continuous raw samples for at least 30 minutes,
- rate and channel count consistent with captured protocol metadata,
- plausible raw amplitude and spectrum during eyes-open/eyes-closed and movement checks,
- real-time DSA output without inferred or synthetic samples,
- recovery after an intentional disconnect,
- a redacted real FC-11 capture retained as a deterministic regression fixture.

## Deliverables

1. A redacted official-app Bluetooth transcript for FC-11 firmware 1.1.6.
2. A short protocol specification separating observed facts from inferred fields.
3. An offline ATT/protobuf capture analyser integrated with the existing replay workflow.
4. A firmware-scoped FC-11 connector and decoder backed by real capture fixtures.
5. A physical-device validation report, or a clear conclusion that raw EEG is unavailable/privately gated on this firmware.

## What is needed from you

The first step requiring your participation is a successful official FocusCalm session captured from the iPhone/Mac. I can then analyse the exported Bluetooth trace. If Apple’s trace omits ATT payloads, the fallback is an inexpensive nRF52840 sniffer on the Mac or PC; borrowing an Android phone for one HCI-snoop recording is another option.

## Safety and scope

- Run protocol discovery off-patient and outside a clinical case.
- Do not brute-force arbitrary commands; unknown control opcodes could reset, update or shut down the device.
- Do not claim compatibility until real FC-11 packets produce a stable, physiologically plausible trace and DSA.
- Muse 2 behavior remains unchanged.
