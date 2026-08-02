CREATE TABLE public.ai_alert_actions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  alert_id text NOT NULL,
  alert_title text NOT NULL DEFAULT '',
  alert_category text NOT NULL DEFAULT 'other',
  alert_severity text NOT NULL DEFAULT 'advisory',
  action text NOT NULL CHECK (action IN ('acknowledged','escalated','resolved')),
  note text,
  escalated_to text,
  context text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX ai_alert_actions_user_created_idx ON public.ai_alert_actions (user_id, created_at DESC);
CREATE INDEX ai_alert_actions_session_idx ON public.ai_alert_actions (session_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_alert_actions TO authenticated;
GRANT ALL ON public.ai_alert_actions TO service_role;

ALTER TABLE public.ai_alert_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own alert actions" ON public.ai_alert_actions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);