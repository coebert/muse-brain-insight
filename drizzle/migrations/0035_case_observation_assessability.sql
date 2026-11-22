-- A stimulus-response observation records what was seen and how it was
-- assessed. It no longer carries a "depth adequate" meaning: no movement can
-- be caused by paralysis, sedation, deafness or a blocked motor pathway.
ALTER TABLE public.case_observations
  ADD COLUMN IF NOT EXISTS motor_assessable boolean,
  ADD COLUMN IF NOT EXISTS response_method text;

ALTER TABLE public.case_observations
  DROP CONSTRAINT IF EXISTS case_observations_response_method_check;

ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_response_method_check
  CHECK (
    response_method IS NULL
    OR response_method IN (
      'voluntary_command',
      'isolated_forearm',
      'emg',
      'clinical_observation',
      'blocked',
      'unknown'
    )
  );

COMMENT ON COLUMN public.case_observations.motor_assessable IS
  'Whether the motor pathway could be assessed when the event was marked. NULL means it was not recorded.';

COMMENT ON COLUMN public.case_observations.response_method IS
  'How a stimulus response was elicited or observed. blocked/unknown negatives are ineligible for derived transitions and training targets.';
