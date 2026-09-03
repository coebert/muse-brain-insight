CREATE TABLE public.external_reference_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source TEXT NOT NULL DEFAULT 'vitaldb',
  source_lineage TEXT NOT NULL DEFAULT 'external:vitaldb',
  case_ref TEXT NOT NULL,
  at_seconds NUMERIC NOT NULL,
  bis NUMERIC NOT NULL,
  bis_sef NUMERIC,
  bis_sr NUMERIC,
  bis_emg NUMERIC,
  sqi NUMERIC,
  ce JSONB NOT NULL DEFAULT '{}'::jsonb,
  age_band TEXT,
  sex TEXT,
  regimen TEXT,
  asa TEXT,
  frailty TEXT,
  external_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX external_reference_points_user_ref_idx
  ON public.external_reference_points (user_id, external_ref);
CREATE INDEX external_reference_points_user_case_idx
  ON public.external_reference_points (user_id, case_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.external_reference_points TO authenticated;
GRANT ALL ON public.external_reference_points TO service_role;

ALTER TABLE public.external_reference_points ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own external reference points"
  ON public.external_reference_points
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);