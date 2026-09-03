# Roadmap

- [x] PhysioNet ingestion (eeg-gaba-anesthesia raw, eeg-power-anesthesia spectra) storing burst-suppression labels and DSA power features with source_lineage.
- [x] Harmonisation step normalising montage/reference differences, recording transform details for auditing.
- [x] External validation pipeline: train on internal data, benchmark COEBIS/diagnostic models per dataset lineage separately (never pooled).
- [x] DOSE-I and I-CARE ingest panels feeding the external validation pipeline under their own lineages.
- [x] DSA grid panel: power, suppression and SEF95 on the DSA time axis for a replayed real EEG file.
- [x] COEBIS replay dashboard (/replay): predicted BIS vs real monitor readings with timeline, agreement metrics and per-covariate comparison against the VitalDB prior.
- [x] Automated public-dataset intake: configured source catalogue with licence gating, index discovery (PhysioNet RECORDS / Zenodo), download, parse + harmonise + store, and per-file licence/provenance records.
- [ ] Systematic public-dataset programme: ingest and benchmark every accessible public EEG collection (VitalDB, PhysioNet GABA/power, DOSE-I, I-CARE, TUH seizure/artifact, CHB-MIT) lineage by lineage, using them for priors, benchmarking and pathology-diagnosis models — never pooled into the device-specific COEBIS fit.

- [x] Scheduled COEBIS refit pipeline: nightly cron (`/api/public/hooks/coebis-refit`), per-lineage versioning in `coebis_model_versions`, run history, and before/after performance in the Model performance page.
