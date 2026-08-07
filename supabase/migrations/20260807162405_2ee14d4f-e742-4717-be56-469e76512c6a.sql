CREATE TABLE public.bis_paired_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  session_id uuid REFERENCES public.eeg_sessions(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  at_seconds numeric NOT NULL,
  bis numeric NOT NULL,
  bis_sr numeric,
  bis_sef numeric,
  app_index numeric NOT NULL,
  app_sr numeric,
  app_sef numeric,
  reliable boolean NOT NULL DEFAULT true,
  sqi numeric,
  context text,
  device text
);

CREATE INDEX bis_paired_points_user_idx ON public.bis_paired_points (user_id, recorded_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bis_paired_points TO authenticated;
GRANT ALL ON public.bis_paired_points TO service_role;
ALTER TABLE public.bis_paired_points ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own BIS paired points"
  ON public.bis_paired_points FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.depth_bis_alignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  gain numeric NOT NULL,
  "offset" numeric NOT NULL,
  n_points integer NOT NULL,
  n_sessions integer NOT NULL,
  bias_before numeric,
  bias_after numeric,
  mae_before numeric,
  mae_after numeric,
  auto_applied boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  note text
);

CREATE INDEX depth_bis_alignments_user_idx ON public.depth_bis_alignments (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.depth_bis_alignments TO authenticated;
GRANT ALL ON public.depth_bis_alignments TO service_role;
ALTER TABLE public.depth_bis_alignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own depth alignments"
  ON public.depth_bis_alignments FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);