ALTER TABLE public.eeg_epochs ALTER COLUMN suppression_ratio DROP NOT NULL;
ALTER TABLE public.eeg_epochs ALTER COLUMN is_suppressed DROP NOT NULL;
COMMENT ON COLUMN public.eeg_epochs.suppression_ratio IS 'Suppression ratio %, or NULL when withheld because the device amplitude scale is not calibrated.';
COMMENT ON COLUMN public.eeg_epochs.is_suppressed IS 'Suppression verdict, or NULL when withheld because the device amplitude scale is not calibrated.';