# Roadmap

- [x] Bulk VitalDB waveform intake: 33 cases, 38,952 paired readings under vitaldb-snuadc|AF7-AF8|128 (5,500+ candidates remain).
- [x] Full-set COEBIS refit: vitaldb v2 PROMOTED (MAE 8.17→7.00, 33 case-folds, +1.17). v1 (−1.25) superseded.
- [x] DOSE-I refit re-run (forced, scripts/refit-lineage.ts): 3,465 readings / 40 case-folds, v1 incumbent retained (mae_gain -0.12). Per-lineage training budget added so VitalDB no longer starves other lineages.
- [x] Graded depth-state (56 cases, COEBIS AUC 0.88) and recorded suppression (34 cases, SR AUC 0.81, COEBIS 0.46).
- [ ] Train suppression model on VitalDB SR labels (bis_sr≥5 vs ≤1) on app_sr+app_sef, versioned storage, wire into pathology labels + depth suppression flag.
- [x] /blockers page: gate status per lineage (cases/readings still needed, data-block vs evidence-block) + covariate headroom, pooled and per lineage.
- [ ] Patient dashboard: gate status column/filter; verify VitalDB lineage now shows promoted model.
- [ ] Optional: continue VitalDB intake (candidates.txt has ~5,500 more cases).
