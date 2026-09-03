CREATE TABLE public.dataset_intake_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  sources_scanned integer NOT NULL DEFAULT 0,
  files_ingested integer NOT NULL DEFAULT 0,
  epochs_inserted integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dataset_intake_runs TO authenticated;
GRANT ALL ON public.dataset_intake_runs TO service_role;

ALTER TABLE public.dataset_intake_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own intake runs select" ON public.dataset_intake_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own intake runs insert" ON public.dataset_intake_runs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own intake runs update" ON public.dataset_intake_runs
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own intake runs delete" ON public.dataset_intake_runs
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.dataset_intake_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  run_id uuid NOT NULL,
  source_id text NOT NULL,
  lineage text NOT NULL,
  file_name text NOT NULL,
  file_url text NOT NULL,
  status text NOT NULL DEFAULT 'ingested',
  epochs integer NOT NULL DEFAULT 0,
  inserted integer NOT NULL DEFAULT 0,
  detail text,
  licence text,
  licence_url text,
  dataset_version text,
  content_digest text,
  bytes bigint,
  harmonization_version text,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dataset_intake_files TO authenticated;
GRANT ALL ON public.dataset_intake_files TO service_role;

ALTER TABLE public.dataset_intake_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own intake files select" ON public.dataset_intake_files
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own intake files insert" ON public.dataset_intake_files
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own intake files update" ON public.dataset_intake_files
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own intake files delete" ON public.dataset_intake_files
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE INDEX dataset_intake_files_source_idx ON public.dataset_intake_files (source_id, status);
CREATE INDEX dataset_intake_files_run_idx ON public.dataset_intake_files (run_id);
CREATE UNIQUE INDEX dataset_intake_files_unique_url ON public.dataset_intake_files (user_id, source_id, file_url, run_id);
