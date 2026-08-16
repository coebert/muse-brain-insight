-- Phase 1: capture the data a covariate-aware depth model needs.

-- 1.1 Epoch-anchored feature/covariate/drug snapshot on each paired reading.
ALTER TABLE public.bis_paired_points
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ce jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS feature_source text NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS bis_paired_points_session_idx
  ON public.bis_paired_points (user_id, session_id);

-- 1.2 Persisted TCI record: one row per pump, one row per target change.
CREATE TABLE IF NOT EXISTS public.tci_infusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  model_key text NOT NULL,
  started_seconds numeric NOT NULL DEFAULT 0,
  stopped_seconds numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tci_infusions TO authenticated;
GRANT ALL ON public.tci_infusions TO service_role;
ALTER TABLE public.tci_infusions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own tci infusions" ON public.tci_infusions
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS tci_infusions_session_idx ON public.tci_infusions (user_id, session_id);

CREATE TABLE IF NOT EXISTS public.tci_ce_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  infusion_id uuid NOT NULL REFERENCES public.tci_infusions(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  at_seconds numeric NOT NULL,
  targets jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tci_ce_points TO authenticated;
GRANT ALL ON public.tci_ce_points TO service_role;
ALTER TABLE public.tci_ce_points ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own tci ce points" ON public.tci_ce_points
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS tci_ce_points_infusion_idx ON public.tci_ce_points (user_id, infusion_id);

-- 1.3 Structured, queryable modelling covariates on the case record.
ALTER TABLE public.eeg_sessions
  ADD COLUMN IF NOT EXISTS regimen text,
  ADD COLUMN IF NOT EXISTS frailty text;

-- Phase 2/3: richer model artefacts on the stored alignment.
ALTER TABLE public.depth_bis_alignments
  ADD COLUMN IF NOT EXISTS model_family text NOT NULL DEFAULT 'affine',
  ADD COLUMN IF NOT EXISTS coefficients jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cv_metrics jsonb NOT NULL DEFAULT '{}'::jsonb;