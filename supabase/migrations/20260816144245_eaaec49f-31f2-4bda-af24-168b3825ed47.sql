CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TABLE public.case_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  delirium text NOT NULL DEFAULT 'unknown',
  delirium_days integer,
  emergence text NOT NULL DEFAULT 'unknown',
  awareness boolean NOT NULL DEFAULT false,
  unplanned_icu boolean NOT NULL DEFAULT false,
  mortality_30d boolean NOT NULL DEFAULT false,
  length_of_stay_days numeric,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (session_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_outcomes TO authenticated;
GRANT ALL ON public.case_outcomes TO service_role;

ALTER TABLE public.case_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own case outcomes" ON public.case_outcomes
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_case_outcomes_updated_at
  BEFORE UPDATE ON public.case_outcomes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.coebis_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alignment_id uuid REFERENCES public.depth_bis_alignments(id) ON DELETE SET NULL,
  label text NOT NULL DEFAULT '',
  note text,
  model_version integer,
  model_family text NOT NULL DEFAULT 'affine',
  coefficients jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked_at timestamp with time zone NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.coebis_locks TO authenticated;
GRANT ALL ON public.coebis_locks TO service_role;

ALTER TABLE public.coebis_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own coebis locks" ON public.coebis_locks
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_coebis_locks_updated_at
  BEFORE UPDATE ON public.coebis_locks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.bis_paired_points
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS source_site text,
  ADD COLUMN IF NOT EXISTS external_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS bis_paired_points_external_ref_key
  ON public.bis_paired_points (user_id, external_ref)
  WHERE external_ref IS NOT NULL;