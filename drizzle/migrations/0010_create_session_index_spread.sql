CREATE OR REPLACE FUNCTION public.session_index_spread()
RETURNS TABLE(session_id uuid, median_index numeric, min_index numeric, max_index numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.session_id,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY e.depth_index)::numeric, 1),
         round(min(e.depth_index)::numeric, 1),
         round(max(e.depth_index)::numeric, 1)
  FROM public.eeg_epochs e
  WHERE e.user_id = auth.uid() AND e.depth_index IS NOT NULL
  GROUP BY e.session_id
$$;

GRANT EXECUTE ON FUNCTION public.session_index_spread() TO authenticated;
GRANT EXECUTE ON FUNCTION public.session_index_spread() TO service_role;