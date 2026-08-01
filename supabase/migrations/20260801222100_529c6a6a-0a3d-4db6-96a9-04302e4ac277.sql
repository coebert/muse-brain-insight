ALTER TABLE public.eeg_sessions
  ADD COLUMN IF NOT EXISTS age_years integer,
  ADD COLUMN IF NOT EXISTS age_band text,
  ADD COLUMN IF NOT EXISTS sex text,
  ADD COLUMN IF NOT EXISTS admission_diagnosis text,
  ADD COLUMN IF NOT EXISTS clinical_features text[] NOT NULL DEFAULT '{}'::text[];