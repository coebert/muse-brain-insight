# Additional public EEG sources for COEBIS and the diagnostic models

## What the search found

Your existing catalogue (`docs/external-eeg-datasets.md`) already covers VitalDB,
GABA/power-anaesthesia, DOSE-I, I-CARE, TUH and CHB-MIT. This search surfaced the
following sources that are **not** in the catalogue, ordered by fit for this app:

### High value — new candidates

| Source | Why it matters for us | Access |
| --- | --- | --- |
| **BDSP burst-suppression of deep hypothermia** (bdsp.io) | Real human burst-suppression EEG from cardiac-surgery cooling — a second ground-truth corpus for the suppression model, completely different aetiology to I-CARE, and BDSP is open access | Open |
| **Real-time burst-suppression segmentation set** (bdsp.io `bsupp`) | Expert-segmented burst/suppression intervals in critical-care EEG — ideal for scoring the suppression detector against human labels | Restricted (credential) |
| **OpenBSR** (Connor, Anesth Analg 2024, PMC) | Not a dataset but an open algorithm concordant with the BIS monitor's burst-suppression ratio — a published reference to cross-check our SR detector against | Open (code/paper) |
| **OpenNeuro ds005620** — repeated-awakening propofol study | 21 subjects, 65-channel EEG, awakening labels during propofol — already supported by the existing OpenNeuro intake script; useful for depth-state (not BIS) grading | CC0, direct download |
| **OpenNeuro ds006695** — UCSD forehead patch sleep | 3-channel **frontal** EEG — the closest montage yet to the headband; usable for the harmonisation path and frontal-reference testing | CC0, direct download |
| **Bitbrain BOAS / wearable sleep sets** (OpenNeuro ds005555 + bitbrain.com) | Simultaneous gold-standard PSG and wearable frontal headband EEG across 128 nights — directly relevant to validating the headband against clinical montage (sleep, not anaesthesia, but same device class) | Open |

### Lower priority for this app
- Multimodal EEG-fNIRS anaesthesia set (NEMAR on004541) — fNIRS adds nothing to the models.
- Intracranial conscious-perception datasets — wrong signal type entirely.
- The propofol-vs-sevoflurane signature paper (medRxiv 2024) is a publication, not data; worth reading for the drug-signature library but no files to import.

## Plan

1. **Update `docs/external-eeg-datasets.md`** with the six candidates above: what each
   contains, access/licence, and which model layer it would serve (suppression priors,
   depth-state grading, frontal-montage harmonisation, headband-vs-PSG validation).
2. **Build intake for the two highest-value open sets**, following the existing patterns:
   - **BDSP hypothermia burst suppression** — EDF-based, open access; add a
     `bdsp-hypothermia` lineage in the pathology-datasets path, epochs labelled by
     burst/suppression intervals, stored as priors/validation only.
   - **OpenNeuro ds005620** — extend the existing `run-ds005620-intake` script path if
     not already wired into the UI panel, using awakening/LOC event labels as
     depth-state grades.
3. **Grade, don't promote blindly**: run both through the suppression/depth-state
   graders and report AUC against the existing external-validation framework; no model
   promotion unless the gate clears, per current rules.
4. **Record OpenBSR as a reference algorithm** in the docs and (optionally) compare its
   SR output to our detector on one stored burst-suppression lineage, shown on the
   suppression dashboard.

## Out of scope (needs your decision later)
- Restricted sets (PhysioNet power-anaesthesia, BDSP `bsupp`) require your personal
  credentialing and a signed DUA — I can't download those for you.
- TUH EEG (rsync application) — same reason.

## Technical notes
- New lineage strings keep each source visible in the lineage UI; nothing back-fills a
  device-specific model (per the montage-mismatch constraint already in the docs).
- EDF decoding reuses `src/lib/eeg/edf.ts`; labelling reuses `pathology-datasets.ts`
  and `physionet.ts` row shapes, so no schema change is expected.
