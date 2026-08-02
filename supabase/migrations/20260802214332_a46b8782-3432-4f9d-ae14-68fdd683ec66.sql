CREATE TABLE public.ai_alert_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  alert_id text NOT NULL,
  alert_category text NOT NULL DEFAULT 'other',
  alert_severity text NOT NULL DEFAULT 'advisory',
  alert_title text NOT NULL DEFAULT '',
  verdict text NOT NULL CHECK (verdict IN ('correct','incorrect','unsure')),
  reason text,
  context text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX ai_alert_feedback_user_created_idx ON public.ai_alert_feedback (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_alert_feedback TO authenticated;
GRANT ALL ON public.ai_alert_feedback TO service_role;

ALTER TABLE public.ai_alert_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own alert feedback" ON public.ai_alert_feedback
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);