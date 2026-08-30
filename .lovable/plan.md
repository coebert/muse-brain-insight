# Getting the Regul8 headband to stream reliably

## What the review found

The app currently connects to the Regul8 by *guessing*. It opens a broad Bluetooth chooser, connects, lists every service, subscribes to every notifying characteristic, optionally sends a BrainCo "ZenLite" pair + start sequence that was reverse-engineered from BrainCo's public OxyZen SDK documentation, listens for about 3 seconds, and then statistically scores the bytes to see whether they "look like EEG". If nothing scores highly enough it aborts the whole connection.

Every protocol-level value in that path is an assumption:

- The ZenLite service/characteristic IDs, the `BRNC` frame layout, the CRC, the pair/validate/AFE command numbers and the 256 Hz rate all come from a *different* BrainCo product's SDK docs, never from this headband.
- The rule for finding EEG samples inside the reply is a structural guess ("largest length-delimited field that is a multiple of three bytes").
- A 3-second listening window and an autocorrelation score of 0.6 decide success or failure.

A separate web investigation found no public Regul8 documentation at all, no BrainCo/FocusCalm Web Bluetooth client, no BrainFlow or LSL support, and no published EEG protobuf schema. The only firm public fact is that BrainCo uses `BRNC` + protobuf + CRC16 framing across its product families.

So the reason the connection keeps failing is not a bug to patch — it is that the app is negotiating with a protocol nobody has actually observed. Guessing again will not fix it. The strategy below replaces guessing with evidence, in stages, and each stage produces something useful on its own.

## Strategy

### Stage 1 — Establish ground truth off-device (no headband needed)

Recover the real protocol from the vendor's own Android app (the FocusCalm / OxyZen package) and any shipped SDK binaries: extract the Bluetooth service and characteristic identifiers, the command constants, and — most importantly — the protobuf definitions for the EEG data messages, which are normally recoverable from the compiled app.

Outcome: either a verified protocol specification, or firm proof that raw EEG is never exposed over Bluetooth on this hardware (in which case we stop chasing it and say so plainly).

### Stage 2 — Make the headband tell us what it is (in-app, never fails)

Add an **Identify headband** mode that is separate from starting a case. It connects, then:

- reads the manufacturer, model, hardware and firmware strings,
- lists every service and characteristic with its properties,
- reads every readable characteristic,
- subscribes to every notifying characteristic and simply *watches for 30 seconds*, reporting per-characteristic packet counts, sizes and first bytes,
- never aborts on "no EEG decoded" — it always ends with a report.

The report is shown on screen in plain language and exported with one tap. This single change turns each failed attempt into usable evidence instead of a dead end.

### Stage 3 — Fix the parts of the current flow that can fail even with a correct protocol

- Extend the listening window from 3 seconds to a configurable 15–30 seconds; some bands only begin streaming after their own startup or contact check.
- Keep the link alive and the notifications open while waiting, rather than tearing down on the first unsuccessful decode.
- Report per-characteristic activity during the attempt so a silent stream is distinguishable from an undecodable one.
- Retry the pair-mode handshake with proper spacing, and treat a device that answers the handshake but sends no data as a distinct, named outcome.

### Stage 4 — Controlled activation probe (only if Stage 1 leaves gaps)

An explicit, clinician-initiated **Advanced: protocol probe** that walks a curated list of documented activation sequences — BrainCo `BRNC` variants (pair, validate, AFE on at 128/256 Hz, start data stream), Nordic UART text commands, and standard start bytes — one at a time, each followed by an observation window, logging exactly which sequence produces traffic. It runs only when the user starts it, with the headband off a patient, and is clearly labelled as an engineering tool.

### Stage 5 — Decode with the recovered schema

Replace the heuristic sample-finder with the real message definition from Stage 1: correct field, correct sample width and endianness, correct channel count and sample rate, correct microvolt scaling from the vendor's ADC constants. Add a fixture test built from a real captured session so the decoder is locked to observed bytes, not to synthetic data.

### Stage 6 — Confirm on hardware and lock it in

Validate against the physical headband: stable connection, continuous stream, plausible amplitudes, sensible spectrum, survival of a disconnect/reconnect, and a clean stream test. Then keep a replayable capture of the real session in the test suite so future changes cannot silently break it.

## What I need from you

Two things would shorten this considerably:

1. A photo of the label on the headband and its charging case/box — the model number, and especially any FCC or CE identifier, will confirm who actually manufactures it.
2. Confirmation of which phone app you use successfully with it (FocusCalm, OxyZen, or a Regul8-branded app) and the exact app name in the store.

I will proceed with Stage 1 regardless; these just remove guesswork about which vendor app to analyse.

## Technical notes

- Files involved: `src/lib/eeg/ble-eeg.ts` (connection, discovery, subscription, format scoring), `src/lib/eeg/brainco-zenlite.ts` (framing, CRC, commands, payload extraction), `src/lib/eeg/ble-diagnostics.ts` and `ble-replay.ts` (capture and offline re-decode), `src/components/monitor/BleHeadsetPanel.tsx` and `BleDiagnosticsPanel.tsx` (UI).
- Stage 2 is a new non-destructive code path alongside `BleHeadsetSource.start()`; it must not send any write to an unrecognised device.
- Stage 5 replaces the leaf-field heuristic in `brainco-zenlite.ts` with an explicit message decoder; the existing `BRNC` deframer, CRC and resync logic are sound and stay.
- Muse 2 behaviour is untouched throughout.
