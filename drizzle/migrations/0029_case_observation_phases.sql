ALTER TABLE public.case_observations
  ADD COLUMN IF NOT EXISTS phase text;

ALTER TABLE public.case_observations
  DROP CONSTRAINT IF EXISTS case_observations_phase_check;
ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_phase_check
  CHECK (phase IS NULL OR phase = ANY (ARRAY['induction'::text, 'maintenance'::text, 'emergence'::text, 'recovery'::text]));

ALTER TABLE public.case_observations
  DROP CONSTRAINT IF EXISTS case_observations_kind_check;
ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_kind_check
  CHECK (kind = ANY (ARRAY['responsiveness'::text, 'drug'::text, 'event'::text, 'note'::text, 'state'::text, 'phase'::text]));

-- The original shape constraint predates the state tag and never learned about
-- it, so a state or phase row could never be written. Replaced by one rule
-- that covers every kind.
ALTER TABLE public.case_observations
  DROP CONSTRAINT IF EXISTS case_observations_shape;
ALTER TABLE public.case_observations
  DROP CONSTRAINT IF EXISTS case_observations_payload_check;
ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_payload_check
  CHECK (
    (kind = 'responsiveness' AND moaas IS NOT NULL)
    OR (kind = 'drug' AND drug_name IS NOT NULL)
    OR (kind = 'event' AND event_type IS NOT NULL)
    OR (kind = 'note' AND note IS NOT NULL)
    OR (kind = 'state' AND state_label IS NOT NULL)
    OR (kind = 'phase' AND phase IS NOT NULL)
  );