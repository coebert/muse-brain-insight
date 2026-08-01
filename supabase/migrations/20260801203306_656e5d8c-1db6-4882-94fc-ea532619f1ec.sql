CREATE TABLE public.eeg_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  case_code TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT 'general_anaesthesia',
  location TEXT,
  notes TEXT,
  device_name TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  mean_suppression_ratio NUMERIC NOT NULL DEFAULT 0,
  max_suppression_ratio NUMERIC NOT NULL DEFAULT 0,
  suppression_seconds NUMERIC NOT NULL DEFAULT 0,
  seizure_alerts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.eeg_epochs (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  t_offset_seconds NUMERIC NOT NULL,
  suppression_ratio NUMERIC NOT NULL DEFAULT 0,
  is_suppressed BOOLEAN NOT NULL DEFAULT false,
  seizure_score NUMERIC NOT NULL DEFAULT 0,
  total_power NUMERIC NOT NULL DEFAULT 0,
  spectral_edge_95 NUMERIC NOT NULL DEFAULT 0,
  bands JSONB NOT NULL DEFAULT '{}'::jsonb,
  spectrum JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.eeg_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  t_offset_seconds NUMERIC NOT NULL,
  duration_seconds NUMERIC NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX eeg_epochs_session_idx ON public.eeg_epochs(session_id, t_offset_seconds);
CREATE INDEX eeg_events_session_idx ON public.eeg_events(session_id, t_offset_seconds);
CREATE INDEX eeg_sessions_user_idx ON public.eeg_sessions(user_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.eeg_sessions TO authenticated;
GRANT ALL ON public.eeg_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.eeg_epochs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.eeg_epochs_id_seq TO authenticated;
GRANT ALL ON public.eeg_epochs TO service_role;
GRANT ALL ON SEQUENCE public.eeg_epochs_id_seq TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.eeg_events TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.eeg_events_id_seq TO authenticated;
GRANT ALL ON public.eeg_events TO service_role;
GRANT ALL ON SEQUENCE public.eeg_events_id_seq TO service_role;

ALTER TABLE public.eeg_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eeg_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.eeg_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own sessions" ON public.eeg_sessions FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own epochs" ON public.eeg_epochs FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own events" ON public.eeg_events FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);