CREATE TABLE public.capture_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  capture_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  device_name text,
  montage text,
  sample_rate integer,
  lineage_key text,
  epoch_count integer NOT NULL DEFAULT 0,
  filed_session_id uuid REFERENCES public.eeg_sessions(id) ON DELETE SET NULL,
  harvested_session_id uuid REFERENCES public.eeg_sessions(id) ON DELETE SET NULL,
  harvested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, capture_key)
);

CREATE TABLE public.capture_epochs (
  id bigserial PRIMARY KEY,
  capture_id uuid NOT NULL REFERENCES public.capture_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  epoch_index integer NOT NULL,
  at_seconds double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  depth_index double precision,
  sef95 double precision,
  suppression_ratio double precision,
  epoch_suppression double precision,
  total_power double precision,
  amplitude_uv double precision,
  sqi double precision,
  quality_grade text,
  artifact boolean NOT NULL DEFAULT false,
  bands jsonb NOT NULL DEFAULT '{}'::jsonb,
  ratios jsonb NOT NULL DEFAULT '{}'::jsonb,
  spectrum jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (capture_id, epoch_index)
);

CREATE INDEX capture_epochs_capture_idx ON public.capture_epochs (capture_id, epoch_index);
CREATE INDEX capture_sessions_user_idx ON public.capture_sessions (user_id, last_seen_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.capture_sessions TO authenticated;
GRANT ALL ON public.capture_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capture_epochs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.capture_epochs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.capture_epochs_id_seq TO service_role;
GRANT ALL ON public.capture_epochs TO service_role;

ALTER TABLE public.capture_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_epochs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own captures select" ON public.capture_sessions FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own captures insert" ON public.capture_sessions FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "own captures update" ON public.capture_sessions FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "own captures delete" ON public.capture_sessions FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE POLICY "own capture epochs select" ON public.capture_epochs FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own capture epochs insert" ON public.capture_epochs FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "own capture epochs update" ON public.capture_epochs FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "own capture epochs delete" ON public.capture_epochs FOR DELETE TO authenticated USING (user_id = auth.uid());