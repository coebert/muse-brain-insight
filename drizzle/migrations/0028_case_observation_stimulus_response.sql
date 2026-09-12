ALTER TABLE public.case_observations
  DROP CONSTRAINT case_observations_event_type_check;

ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_event_type_check
  CHECK (event_type IS NULL OR event_type IN (
    'seizure','stimulus','movement','arousal','artefact','other',
    'noxious_stimulus','movement_response','still_response'
  ));

COMMENT ON COLUMN public.case_observations.event_type IS 'For kind = event: the clinical event marked at the bedside (seizure-like activity, applied stimulus, movement, arousal, artefact, noxious stimulus, movement in response to a noxious stimulus, or no movement in response to one, other).';