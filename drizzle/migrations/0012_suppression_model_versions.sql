CREATE TABLE public.suppression_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lineage text NOT NULL,
  version integer NOT NULL,
  coefficients jsonb NOT NULL,
  training jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics_before jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics_after jsonb NOT NULL DEFAULT '{}'::jsonb,
  sensitivity_gain numeric,
  mae_gain numeric,
  is_active boolean NOT NULL DEFAULT false,
  data_digest text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lineage, version)
);

CREATE INDEX suppression_model_versions_active_idx
  ON public.suppression_model_versions (user_id, lineage, is_active);

GRANT SELECT, INSERT, UPDATE ON public.suppression_model_versions TO authenticated;
GRANT ALL ON public.suppression_model_versions TO service_role;

ALTER TABLE public.suppression_model_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own suppression model versions"
  ON public.suppression_model_versions
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);