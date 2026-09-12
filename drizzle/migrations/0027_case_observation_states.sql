ALTER TABLE public.case_observations ADD COLUMN IF NOT EXISTS state_label text;

ALTER TABLE public.case_observations DROP CONSTRAINT IF EXISTS case_observations_kind_check;
ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_kind_check
  CHECK (kind IN ('responsiveness','drug','event','note','state'));

ALTER TABLE public.case_observations DROP CONSTRAINT IF EXISTS case_observations_state_label_check;
ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_state_label_check
  CHECK (state_label IS NULL OR state_label IN ('awake','sedated_responsive','sedated_unresponsive','anaesthetised','burst_suppression','emergence'));

ALTER TABLE public.case_observations DROP CONSTRAINT IF EXISTS case_observations_payload_check;
ALTER TABLE public.case_observations
  ADD CONSTRAINT case_observations_payload_check
  CHECK (
    (kind = 'responsiveness' AND moaas IS NOT NULL)
    OR (kind = 'drug' AND drug_name IS NOT NULL)
    OR (kind = 'event' AND event_type IS NOT NULL)
    OR (kind = 'note' AND note IS NOT NULL)
    OR (kind = 'state' AND state_label IS NOT NULL)
  );

COMMENT ON COLUMN public.case_observations.state_label IS 'For kind = state: the clinical state the patient entered at this point on the case clock, using the same vocabulary as the external state-label corpora.';