CREATE TABLE public.session_raw_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.eeg_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  chunk_index integer NOT NULL,
  start_seconds numeric NOT NULL,
  sample_rate numeric NOT NULL,
  sample_count integer NOT NULL,
  scale_uv numeric NOT NULL,
  samples_base64 text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (session_id, channel, chunk_index)
);

CREATE INDEX session_raw_chunks_session_idx
  ON public.session_raw_chunks (session_id, channel, chunk_index);

GRANT SELECT, INSERT, DELETE ON public.session_raw_chunks TO authenticated;
GRANT ALL ON public.session_raw_chunks TO service_role;

ALTER TABLE public.session_raw_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own raw chunks" ON public.session_raw_chunks
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users insert own raw chunks" ON public.session_raw_chunks
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own raw chunks" ON public.session_raw_chunks
  FOR DELETE TO authenticated USING (auth.uid() = user_id);