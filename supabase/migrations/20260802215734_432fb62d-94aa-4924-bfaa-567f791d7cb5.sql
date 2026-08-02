ALTER TABLE public.ai_alert_feedback ADD COLUMN IF NOT EXISTS alert_confidence text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.ai_alert_feedback DROP CONSTRAINT IF EXISTS ai_alert_feedback_verdict_check;
ALTER TABLE public.ai_alert_feedback ADD CONSTRAINT ai_alert_feedback_verdict_check CHECK (verdict = ANY (ARRAY['correct'::text,'incorrect'::text,'unsure'::text,'missed'::text]));