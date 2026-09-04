CREATE INDEX IF NOT EXISTS external_spectral_epochs_user_created_idx
  ON public.external_spectral_epochs (user_id, created_at, id);

CREATE INDEX IF NOT EXISTS bis_paired_points_user_id_idx
  ON public.bis_paired_points (user_id, id);

CREATE INDEX IF NOT EXISTS external_reference_points_user_case_idx
  ON public.external_reference_points (user_id, case_ref, at_seconds);