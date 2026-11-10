# Roadmap — research-integrity & measurement fixes (Nov 2026)

- [x] 1. coebis-v2-device: withhold COEBIS-2 + µV suppression when amplitude calibration unknown; nulls through UI/save/export/AI digest
- [x] 2. coebis-spectra: no fabricated suppression / logPtp; explicit unavailable result; consumers + tests
- [x] 3. harmonization: no invented gains; source reference preserved; bands unavailable not 0; legacy incompatible for new fits
- [x] 4. diagnosis-model: exploratory-only, eligibility in suggestDiagnosis, confirmed-diagnosis provenance
- [x] 5. interpret.functions: explanatory-only, server-side output guard, feedback offline-only
- [x] 6. Recording model freeze, candidate-only auto-refit, provenance saved
- [x] 7. Experimental asymmetry watch; validation registry; synthetic vs human separation
- [x] Regression tests, typecheck, AGENTS.md rules

## Pass 2 (continue remaining fixes)
- [ ] A. OpenIBIS-style index withholds amplitude-dependent index/components on uncalibrated devices; audit null→0 fallbacks; no stale held score
- [ ] B. Case-notes AI explanatory-only (no feedback-driven ranking/threshold adaptation); guard numeric evidence by metric/value/unit/window
- [ ] C. Hydration mismatch / first-load warning; typecheck, tests, build, authenticated smoke
- [ ] D. Patient grouping: canonical cohort + subject key, case fallback reported, no split leakage; ds004504/ds006036 shared cohort
- [ ] E. DOSE-I v2 (Zenodo 22145442) registry + checksum/version-aware identity, superseded marking; eeg-gaba-anesthesia corrected, excluded from raw training
- [ ] F. Catalogue: ds005873, ds004504, ds006036, ds004796, siena-scalp-eeg, LEMON; verified formats; parser-support or catalogue-only reason
- [ ] G. Corpus audit counts + harmonise-v1 exclusion + bounded resumable reprocess/import jobs
- [ ] Reprocess legacy external collections with harmonise-2.0.0 (needs original files re-imported)
