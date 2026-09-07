-- Job coordination tables are service-role only. Make that explicit:
-- no client privileges at all, RLS on with a deny-all default (no policies).
ALTER TABLE public.analysis_job_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coebis_refit_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_job_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.coebis_refit_state FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.analysis_job_state FROM anon, authenticated;
REVOKE ALL ON public.coebis_refit_state FROM anon, authenticated;

GRANT ALL ON public.analysis_job_state TO service_role;
GRANT ALL ON public.coebis_refit_state TO service_role;
