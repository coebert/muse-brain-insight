CREATE OR REPLACE FUNCTION public.external_depth_exposure(_lineage text)
RETURNS TABLE(
  case_ref text,
  readings bigint,
  seconds numeric,
  mean_index numeric,
  min_index numeric,
  seconds_below_40 numeric,
  seconds_below_30 numeric,
  seconds_above_60 numeric,
  seconds_suppressed numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH r AS (
    SELECT
      p.case_ref,
      p.bis,
      p.bis_sr,
      LEAST(
        GREATEST(
          COALESCE(
            LEAD(p.at_seconds) OVER (PARTITION BY p.case_ref ORDER BY p.at_seconds) - p.at_seconds,
            0
          ),
          0
        ),
        30
      ) AS dt
    FROM public.external_reference_points p
    WHERE p.user_id = auth.uid()
      AND p.source_lineage = _lineage
  )
  SELECT
    r.case_ref,
    count(*)::bigint,
    COALESCE(sum(r.dt), 0),
    CASE WHEN COALESCE(sum(r.dt), 0) > 0
         THEN sum(r.bis * r.dt) / sum(r.dt)
         ELSE avg(r.bis) END,
    min(r.bis),
    COALESCE(sum(r.dt) FILTER (WHERE r.bis < 40), 0),
    COALESCE(sum(r.dt) FILTER (WHERE r.bis < 30), 0),
    COALESCE(sum(r.dt) FILTER (WHERE r.bis > 60), 0),
    COALESCE(sum(r.dt) FILTER (WHERE COALESCE(r.bis_sr, 0) > 0), 0)
  FROM r
  GROUP BY r.case_ref;
$function$;

REVOKE ALL ON FUNCTION public.external_depth_exposure(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.external_depth_exposure(text) TO authenticated;