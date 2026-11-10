# Roadmap — research-integrity & measurement fixes (Nov 2026)

- [x] 1. coebis-v2-device: withhold COEBIS-2 + µV suppression when amplitude calibration unknown; nulls through UI/save/export/AI digest
- [x] 2. coebis-spectra: no fabricated suppression / logPtp; explicit unavailable result; consumers + tests
- [x] 3. harmonization: no invented gains; source reference preserved; bands unavailable not 0; legacy incompatible for new fits
- [x] 4. diagnosis-model: exploratory-only, eligibility in suggestDiagnosis, confirmed-diagnosis provenance
- [x] 5. interpret.functions: explanatory-only, server-side output guard, feedback offline-only
- [x] 6. Recording model freeze, candidate-only auto-refit, provenance saved
- [x] 7. Experimental asymmetry watch; validation registry; synthetic vs human separation
- [x] Regression tests, typecheck, AGENTS.md rules
- [ ] Reprocess legacy external collections with harmonise-2.0.0 (needs original files re-imported)
- [ ] OpenIBIS-style depth index still uses an internal zero BSR on uncalibrated bands (not yet withheld)
- [ ] Case-notes AI pattern ranking still uses verdict feedback (not alert tuning; review separately)
