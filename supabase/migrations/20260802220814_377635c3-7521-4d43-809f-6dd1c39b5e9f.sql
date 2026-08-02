ALTER TABLE public.ai_alert_actions
  ADD COLUMN IF NOT EXISTS override_stance text NOT NULL DEFAULT 'agree',
  ADD COLUMN IF NOT EXISTS override_rationale text,
  ADD COLUMN IF NOT EXISTS cited_features text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS alert_confidence text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS evidence_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;