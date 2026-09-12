ALTER TABLE public.case_observations DROP CONSTRAINT IF EXISTS case_observations_kind_check;
ALTER TABLE public.case_observations DROP CONSTRAINT IF EXISTS case_observations_shape;

ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_kind_check
  CHECK (kind IN ('responsiveness','drug','event','note'));

ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_shape CHECK (
    (kind = 'responsiveness' AND moaas IS NOT NULL)
    OR (kind = 'drug' AND drug_name IS NOT NULL)
    OR (kind = 'event' AND event_type IS NOT NULL)
    OR (kind = 'note' AND note IS NOT NULL)
  );

COMMENT ON COLUMN public.case_observations.note IS 'Free-text note. For kind = note this is a timed, anonymised annotation added against a point on the case timeline, possibly after the case.';