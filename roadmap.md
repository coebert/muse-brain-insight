# Roadmap

- [x] PhysioNet ingestion (eeg-gaba-anesthesia raw, eeg-power-anesthesia spectra) storing burst-suppression labels and DSA power features with source_lineage.
- [ ] Harmonisation step normalising montage/reference differences, recording transform details for auditing (module + persistence done; panel wiring and tests outstanding).
- [ ] External validation pipeline: train on internal data, benchmark COEBIS/diagnostic models per dataset lineage separately.
