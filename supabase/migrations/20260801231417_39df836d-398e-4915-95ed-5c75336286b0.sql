ALTER TABLE public.eeg_epochs ADD COLUMN IF NOT EXISTS depth_components jsonb;

CREATE TABLE IF NOT EXISTS public.depth_state_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  label text NOT NULL,
  start_seconds numeric NOT NULL,
  end_seconds numeric NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.depth_state_labels TO authenticated;
GRANT ALL ON public.depth_state_labels TO service_role;
ALTER TABLE public.depth_state_labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own depth labels" ON public.depth_state_labels FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS depth_state_labels_session_idx ON public.depth_state_labels (session_id);

CREATE TABLE IF NOT EXISTS public.depth_calibrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  params jsonb NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_session_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.depth_calibrations TO authenticated;
GRANT ALL ON public.depth_calibrations TO service_role;
ALTER TABLE public.depth_calibrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own depth calibrations" ON public.depth_calibrations FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);