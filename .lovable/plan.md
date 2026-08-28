# Simplify FocusCalm connection

## Goal
Make FocusCalm pairing a guided, one-action process that clearly shows what is happening and how to recover when the headset is not found or does not stream.

## Changes
- Replace the technical FocusCalm setup form with a prominent **Connect FocusCalm** action using the correct AF7 mapping and automatic scaling by default.
- Keep the start-case dialog open while pairing and show clear stages: choosing the headset, connecting, finding its EEG stream, and confirming signal.
- Start the case only after a usable EEG stream has been confirmed, preventing the current blank/closed-dialog failure experience.
- Translate browser and Bluetooth failures into short, actionable messages, including cancelled selection, another app holding the band, charging mode, and unsupported browser guidance.
- Add a compact preparation checklist and a retry action; put electrode mapping and ADC calibration inside an optional advanced section.
- Prefer previously authorised FocusCalm devices when the browser exposes them, while retaining the device chooser as a fallback.
- Preserve the existing generic BLE decoder and downstream device-specific analysis tuning.

## Technical details
- Extend the BLE source with connection-progress callbacks and a way to preflight/confirm the stream before handing it to the monitor.
- Update the FocusCalm panel and case-start callback so case state changes only after successful preflight.
- Add focused tests for friendly error mapping, progress transitions, and successful preflight reuse.
- Verify the start-case flow in the live preview and run the BLE/unit tests.
