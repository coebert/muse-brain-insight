CREATE TABLE public.external_spectral_epochs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source TEXT NOT NULL,
  source_lineage TEXT NOT NULL,
  dataset_version TEXT,
  case_ref TEXT NOT NULL,
  channel TEXT,
  at_seconds NUMERIC NOT NULL,
  epoch_seconds NUMERIC NOT NULL DEFAULT 4,
  sample_rate NUMERIC,
  freq_start_hz NUMERIC NOT NULL DEFAULT 0.5,
  freq_step_hz NUMERIC NOT NULL DEFAULT 0.5,
  spectrum_db JSONB NOT NULL DEFAULT '[]'::jsonb,
  bands JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_power NUMERIC,
  sef95 NUMERIC,
  suppression_ratio NUMERIC,
  is_suppressed BOOLEAN NOT NULL DEFAULT false,
  label TEXT,
  label_source TEXT NOT NULL DEFAULT 'derived',
  covariates JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.external_spectral_epochs TO authenticated;
GRANT ALL ON public.external_spectral_epochs TO service_role;

ALTER TABLE public.external_spectral_epochs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own external spectral epochs"
ON public.external_spectral_epochs
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE UNIQUE INDEX external_spectral_epochs_user_ref_idx
  ON public.external_spectral_epochs (user_id, external_ref);
CREATE INDEX external_spectral_epochs_lineage_idx
  ON public.external_spectral_epochs (user_id, source_lineage, case_ref);
CREATE INDEX external_spectral_epochs_label_idx
  ON public.external_spectral_epochs (user_id, label);