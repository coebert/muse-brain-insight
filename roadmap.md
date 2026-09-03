# Roadmap

- [x] PhysioNet ingestion (eeg-gaba-anesthesia raw, eeg-power-anesthesia spectra) storing burst-suppression labels and DSA power features with source_lineage.
- [x] Harmonisation step normalising montage/reference differences, recording transform details for auditing.
- [x] External validation pipeline: train on internal data, benchmark COEBIS/diagnostic models per dataset lineage separately (never pooled).
