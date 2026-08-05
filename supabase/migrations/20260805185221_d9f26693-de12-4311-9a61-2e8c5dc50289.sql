CREATE TABLE public.case_pattern_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pattern_key text NOT NULL,
  verdict text NOT NULL DEFAULT 'accepted',
  payload_sealed text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, pattern_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_pattern_feedback TO authenticated;
GRANT ALL ON public.case_pattern_feedback TO service_role;

ALTER TABLE public.case_pattern_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own case pattern feedback" ON public.case_pattern_feedback
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);