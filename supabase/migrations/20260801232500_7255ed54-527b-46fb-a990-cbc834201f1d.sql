ALTER TABLE public.eeg_epochs
  ADD COLUMN IF NOT EXISTS consciousness_index NUMERIC,
  ADD COLUMN IF NOT EXISTS nociception_index NUMERIC,
  ADD COLUMN IF NOT EXISTS composite_components JSONB;