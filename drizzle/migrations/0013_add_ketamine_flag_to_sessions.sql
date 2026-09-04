ALTER TABLE public.eeg_sessions
  ADD COLUMN ketamine_given boolean,
  ADD COLUMN ketamine_detail text;

COMMENT ON COLUMN public.eeg_sessions.ketamine_given IS 'Explicit clinician-filed ketamine exposure: true = given, false = explicitly not given, null = not recorded.';
COMMENT ON COLUMN public.eeg_sessions.ketamine_detail IS 'Optional free-text detail about the ketamine exposure (route, timing, dose band).';