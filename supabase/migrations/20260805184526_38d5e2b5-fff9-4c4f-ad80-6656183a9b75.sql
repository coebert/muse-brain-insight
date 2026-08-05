CREATE TABLE public.case_note_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  fields_sealed text,
  confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, session_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_note_facts TO authenticated;
GRANT ALL ON public.case_note_facts TO service_role;

ALTER TABLE public.case_note_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own case note facts" ON public.case_note_facts
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);