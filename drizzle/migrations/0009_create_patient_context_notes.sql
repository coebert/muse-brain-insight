CREATE TABLE public.patient_context_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  patient_key text NOT NULL,
  patient_label text,
  context_sealed text,
  baseline_sealed text,
  confounders_sealed text,
  read_with_sealed text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, patient_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_context_notes TO authenticated;
GRANT ALL ON public.patient_context_notes TO service_role;

ALTER TABLE public.patient_context_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own patient context notes"
  ON public.patient_context_notes
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_patient_context_notes_updated_at
  BEFORE UPDATE ON public.patient_context_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();