# Roadmap

- [x] Bulk VitalDB waveform intake: 33 cases, 38,952 paired readings under vitaldb-snuadc|AF7-AF8|128 (5,500+ candidates remain).
- [x] Full-set COEBIS refit: vitaldb v2 PROMOTED (MAE 8.17→7.00, 33 case-folds, +1.17). v1 (−1.25) superseded.
- [ ] Train suppression model on VitalDB SR labels (bis_sr≥5 vs ≤1) on app_sr+app_sef, versioned storage, wire into pathology labels + depth suppression flag.
- [ ] Patient dashboard: gate status column/filter; verify VitalDB lineage now shows promoted model.
- [ ] Optional: continue VitalDB intake (candidates.txt has ~5,500 more cases).
