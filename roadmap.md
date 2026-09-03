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
- [x] COEBIS prediction intervals on the replay timeline and paired prediction charts, with coverage/spread calibration scored against real BIS readings.
- [x] Pathology dataset ingest panels (TUSZ, CHB-MIT, TUAB, Helsinki neonatal) in Data exchange, with interval annotations and per-lineage licence provenance.
- [x] CHB-MIT (PhysioNet, ODC-BY) wired into the automated intake as `external:physionet:chb-mit` with an EDF reader and published seizure intervals; external validation now shown on Model performance.
- [ ] PhysioNet GABA / power intake: both are credentialed (HTTP 403 to unattended fetch) — only the manual import panels can ingest them once files are downloaded under a signed DUA.
- [ ] Model comparison page: every COEBIS version with MAE, bias and lineage, selectable as the active fit.
- [ ] Trigger a refit on demand and show the new version's before/after MAE and gain on Model performance.
- [x] Drift detection metric comparing each refit against the original COEBIS fit (Model performance → Model drift vs original fit).
- [ ] Clinical case dashboard: EEG, COEBIS, BIS, propofol Ce and covariates in one view with suppression/power highlights.
- [ ] Pathology dashboard: COEBIS vs published labels with suppression, SEF, power and per-lineage prior (TUSZ, CHB-MIT, Helsinki neonatal).
- [ ] Prediction-interval coverage compared across lineages after further PhysioNet/VitalDB intake.
- [ ] Error hotspots overlay: contiguous regions where bias or MAE crosses a threshold, per lineage.
- [x] OpenNeuro ds004541 (CC0 general-anaesthesia EEG-fNIRS) wired into the automated intake as `external:openneuro:ds004541`: BIDS snapshot discovery, range-fetched EDF prefixes, frontal-channel DSA epochs labelled from the published events file, and any BIS-style monitor channel stored as a monitor reading.
- [x] Covariate–feature discovery pass: run the AI over every raw EEG lineage that also carries age, sex, comorbidity and anaesthetic/sedative agent covariates; surface spectral/suppression/coherence features that correlate with each characteristic, with per-lineage effect sizes, sufficiency gates and multiplicity control. Feed validated findings into (a) COEBIS covariate terms and (b) the diagnostic suggestion model, keeping external lineages out of the device-specific fit.
