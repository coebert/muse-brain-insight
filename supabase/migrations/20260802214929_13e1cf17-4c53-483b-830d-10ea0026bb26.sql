ALTER TABLE public.ai_alert_feedback
  ADD COLUMN IF NOT EXISTS model_version text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS clinician_label text;

CREATE INDEX IF NOT EXISTS ai_alert_feedback_created_at_idx ON public.ai_alert_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_alert_feedback_model_version_idx ON public.ai_alert_feedback (model_version);