CREATE TABLE public.patient_links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  pseudonym TEXT NOT NULL,
  identifier_sealed TEXT NOT NULL,
  identifier_fingerprint TEXT NOT NULL,
  label_sealed TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX patient_links_user_pseudonym_key ON public.patient_links (user_id, pseudonym);
CREATE UNIQUE INDEX patient_links_user_fingerprint_key ON public.patient_links (user_id, identifier_fingerprint);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_links TO authenticated;
GRANT ALL ON public.patient_links TO service_role;

ALTER TABLE public.patient_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clinicians manage their own patient links"
  ON public.patient_links FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_patient_links_updated_at
  BEFORE UPDATE ON public.patient_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.eeg_sessions
  ADD COLUMN patient_link_id UUID REFERENCES public.patient_links(id) ON DELETE SET NULL,
  ADD COLUMN patient_pseudonym TEXT,
  ADD COLUMN deid_findings JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX eeg_sessions_patient_link_id_idx ON public.eeg_sessions (patient_link_id);