# Roadmap

## Current batch (2026-09-04)
- [ ] Bulk VitalDB waveform intake: pull more cases from the VitalDB API (beyond the current 9), replay + pair, insert into bis_paired_points under vitaldb-snuadc|AF7-AF8|128.
- [ ] Re-run COEBIS refit on the full VitalDB set; see whether the lineage clears the gate and whether the fit earns promotion on its own; new version visible on /models.
- [ ] Train a separate suppression model on VitalDB SR labels (monitor SR>=5% vs app features), versioned + stored, paired with COEBIS so suppression flags align with the real BIS SR.
- [ ] Patient dashboard: COEBIS vs bedside BIS per patient with per-case trace and gate status (mostly /patients; verify coverage incl. VitalDB cases, add gate status where missing).

## Backlog (carried)
- [ ] Systematic public-dataset programme (VitalDB, PhysioNet GABA/power, DOSE-I, I-CARE, TUH, CHB-MIT) lineage by lineage — priors, benchmarking, pathology models; never pooled into the device-specific COEBIS fit.
- [ ] PhysioNet GABA / power intake: credentialed (HTTP 403 unattended) — manual import panels only.
- [ ] Model comparison page: every COEBIS version with MAE, bias and lineage, selectable as active.
- [ ] Trigger a refit on demand; show before/after MAE and gain on Model performance.
- [ ] Clinical case dashboard: EEG, COEBIS, BIS, propofol Ce, covariates in one view.
- [ ] Pathology dashboard: COEBIS vs published labels with suppression, SEF, power and per-lineage prior.
- [ ] Prediction-interval coverage compared across lineages after further intake.
- [ ] Error hotspots overlay per lineage.
