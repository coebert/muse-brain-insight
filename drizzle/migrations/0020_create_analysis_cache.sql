CREATE TABLE public.analysis_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_digest text,
  rows_scanned integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  computed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_key)
);

GRANT SELECT, INSERT, UPDATE ON public.analysis_cache TO authenticated;
GRANT ALL ON public.analysis_cache TO service_role;

ALTER TABLE public.analysis_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read their analysis cache"
  ON public.analysis_cache FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Owners queue their analysis cache"
  ON public.analysis_cache FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owners refresh their analysis cache"
  ON public.analysis_cache FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_analysis_cache_updated_at
  BEFORE UPDATE ON public.analysis_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX analysis_cache_pending_idx
  ON public.analysis_cache (status, requested_at)
  WHERE status IN ('queued', 'running');

CREATE TABLE public.analysis_job_state (
  job_key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'idle',
  paused_reason text,
  lease_until timestamptz,
  holder text,
  last_run_at timestamptz,
  last_error text,
  jobs_processed integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.analysis_job_state TO service_role;

ALTER TABLE public.analysis_job_state ENABLE ROW LEVEL SECURITY;

INSERT INTO public.analysis_job_state (job_key, status) VALUES ('analysis-cache', 'idle');