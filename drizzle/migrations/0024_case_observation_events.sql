ALTER TABLE public.case_observations ADD COLUMN IF NOT EXISTS event_type text;

ALTER TABLE public.case_observations DROP CONSTRAINT IF EXISTS case_observations_kind_check;
ALTER TABLE public.case_observations DROP CONSTRAINT IF EXISTS case_observations_shape;

ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_kind_check
  CHECK (kind IN ('responsiveness','drug','event'));

ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_event_type_check
  CHECK (event_type IS NULL OR event_type IN ('seizure','stimulus','movement','arousal','artefact','other'));

ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_shape CHECK (
    (kind = 'responsiveness' AND moaas IS NOT NULL)
    OR (kind = 'drug' AND drug_name IS NOT NULL)
    OR (kind = 'event' AND event_type IS NOT NULL)
  );

COMMENT ON COLUMN public.case_observations.event_type IS 'For kind = event: the clinical event marked at the bedside (seizure-like activity, applied stimulus, movement, arousal, artefact, other).';