ALTER TABLE public.bis_paired_points ADD COLUMN IF NOT EXISTS source_lineage text;
ALTER TABLE public.depth_bis_alignments ADD COLUMN IF NOT EXISTS lineage text;
ALTER TABLE public.depth_bis_alignments ADD COLUMN IF NOT EXISTS lineage_detail jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.coebis_locks ADD COLUMN IF NOT EXISTS lineage text;
CREATE INDEX IF NOT EXISTS bis_paired_points_lineage_idx ON public.bis_paired_points (user_id, source_lineage);