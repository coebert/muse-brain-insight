ALTER TABLE public.depth_bis_alignments
  ADD COLUMN IF NOT EXISTS knots jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS model_version text NOT NULL DEFAULT 'coebis-1';