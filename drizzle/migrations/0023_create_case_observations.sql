CREATE TABLE public.case_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  case_code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('responsiveness','drug')),
  at_seconds integer NOT NULL CHECK (at_seconds >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  moaas smallint CHECK (moaas IS NULL OR (moaas >= 0 AND moaas <= 5)),
  stimulus text CHECK (stimulus IS NULL OR stimulus IN ('none','name','loud','shake','trapezius')),
  drug_name text,
  dose numeric,
  dose_unit text,
  route text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_observations_shape CHECK (
    (kind = 'responsiveness' AND moaas IS NOT NULL)
    OR (kind = 'drug' AND drug_name IS NOT NULL)
  )
);

COMMENT ON TABLE public.case_observations IS 'Bedside-captured ground truth: timed MOAA/S responsiveness scores and timed drug doses, stamped against the case clock.';

CREATE INDEX case_observations_user_case_idx ON public.case_observations (user_id, case_code, at_seconds);
CREATE INDEX case_observations_session_idx ON public.case_observations (session_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_observations TO authenticated;
GRANT ALL ON public.case_observations TO service_role;

ALTER TABLE public.case_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own case observations"
  ON public.case_observations
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);