CREATE TABLE public.external_case_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source text NOT NULL,
  source_lineage text NOT NULL,
  case_ref text NOT NULL,
  in_hospital_death boolean,
  icu_days numeric,
  hospital_days numeric,
  emergency boolean,
  asa text,
  age_years integer,
  sex text,
  department text,
  optype text,
  approach text,
  comorbidities text[] NOT NULL DEFAULT '{}',
  raw jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_lineage, case_ref)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.external_case_outcomes TO authenticated;
GRANT ALL ON public.external_case_outcomes TO service_role;

ALTER TABLE public.external_case_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own external case outcomes"
  ON public.external_case_outcomes
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX external_case_outcomes_user_case_idx
  ON public.external_case_outcomes (user_id, source_lineage, case_ref);

CREATE TRIGGER update_external_case_outcomes_updated_at
  BEFORE UPDATE ON public.external_case_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();