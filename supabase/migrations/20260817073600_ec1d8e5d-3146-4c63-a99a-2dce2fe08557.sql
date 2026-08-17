ALTER TABLE public.bis_paired_points
  ADD COLUMN IF NOT EXISTS stability text,
  ADD COLUMN IF NOT EXISTS lag_seconds numeric;