ALTER TABLE public.external_spectral_epochs
  ADD COLUMN IF NOT EXISTS harmonization JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS harmonized_montage TEXT,
  ADD COLUMN IF NOT EXISTS harmonization_version TEXT;

CREATE INDEX IF NOT EXISTS external_spectral_epochs_harmonization_idx
  ON public.external_spectral_epochs (user_id, harmonization_version);