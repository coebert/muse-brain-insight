ALTER TABLE public.eeg_sessions ALTER COLUMN mean_suppression_ratio DROP NOT NULL;
ALTER TABLE public.eeg_sessions ALTER COLUMN max_suppression_ratio DROP NOT NULL;
ALTER TABLE public.eeg_sessions ALTER COLUMN suppression_seconds DROP NOT NULL;
COMMENT ON COLUMN public.eeg_sessions.mean_suppression_ratio IS 'Null when suppression could not be measured (device amplitude scale unknown). Never a placeholder 0.';