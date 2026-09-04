CREATE TABLE public.bis_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  lineage text NOT NULL,
  version integer NOT NULL,
  terms jsonb NOT NULL,
  coefficients jsonb NOT NULL,
  training jsonb,
  metrics_before jsonb,
  metrics_after jsonb,
  mae_gain numeric,
  correlation_gain numeric,
  is_active boolean NOT NULL DEFAULT false,
  data_digest text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lineage, version)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bis_model_versions TO authenticated;
GRANT ALL ON public.bis_model_versions TO service_role;

ALTER TABLE public.bis_model_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own bis models select" ON public.bis_model_versions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own bis models insert" ON public.bis_model_versions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own bis models update" ON public.bis_model_versions
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own bis models delete" ON public.bis_model_versions
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX bis_model_versions_active_idx ON public.bis_model_versions (user_id, lineage, is_active, version DESC);