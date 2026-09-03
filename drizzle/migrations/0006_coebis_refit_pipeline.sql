-- Versioned COEBIS models produced by the scheduled refit pipeline.
CREATE TABLE public.coebis_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id uuid,
  lineage_key text NOT NULL,
  version integer NOT NULL,
  model_family text NOT NULL DEFAULT 'covariate',
  coefficients jsonb NOT NULL DEFAULT '{}'::jsonb,
  training jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics_before jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics_after jsonb NOT NULL DEFAULT '{}'::jsonb,
  mae_gain numeric,
  promoted boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT false,
  reason text,
  data_digest text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, lineage_key, version),
  UNIQUE (user_id, lineage_key, data_digest)
);

GRANT SELECT ON public.coebis_model_versions TO authenticated;
GRANT ALL ON public.coebis_model_versions TO service_role;
ALTER TABLE public.coebis_model_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own model versions"
  ON public.coebis_model_versions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX coebis_model_versions_user_lineage_idx
  ON public.coebis_model_versions (user_id, lineage_key, version DESC);

-- History of scheduled/manual refit runs.
CREATE TABLE public.coebis_refit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger text NOT NULL DEFAULT 'scheduled',
  status text NOT NULL DEFAULT 'running',
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  validated_points integer NOT NULL DEFAULT 0,
  rejected jsonb NOT NULL DEFAULT '{}'::jsonb,
  lineages_considered integer NOT NULL DEFAULT 0,
  lineages_refitted integer NOT NULL DEFAULT 0,
  models_promoted integer NOT NULL DEFAULT 0,
  summary text,
  detail jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text
);

GRANT SELECT ON public.coebis_refit_runs TO authenticated;
GRANT ALL ON public.coebis_refit_runs TO service_role;
ALTER TABLE public.coebis_refit_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own refit runs"
  ON public.coebis_refit_runs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX coebis_refit_runs_user_started_idx
  ON public.coebis_refit_runs (user_id, started_at DESC);

-- Single-flight lease and pause state for the scheduled job. Service role only.
CREATE TABLE public.coebis_refit_state (
  job_key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'idle',
  paused_reason text,
  lease_until timestamp with time zone,
  holder text,
  last_run_at timestamp with time zone,
  last_error text,
  users_processed integer NOT NULL DEFAULT 0,
  cursor_user_id uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT ALL ON public.coebis_refit_state TO service_role;
ALTER TABLE public.coebis_refit_state ENABLE ROW LEVEL SECURITY;

INSERT INTO public.coebis_refit_state (job_key) VALUES ('coebis_refit')
  ON CONFLICT (job_key) DO NOTHING;