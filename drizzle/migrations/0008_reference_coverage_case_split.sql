create or replace function public.reference_coverage()
returns table(format_id text, row_count bigint, case_count bigint)
language sql
stable
set search_path = public
as $$
  select 'vitaldb-bis'::text, count(*)::bigint, count(distinct case_ref)::bigint
  from public.external_reference_points
  where user_id = auth.uid() and source = 'vitaldb'
  union all
  select 'figshare-ma-bis', count(*)::bigint,
         count(distinct split_part(external_ref, ':', 3))::bigint
  from public.bis_paired_points
  where user_id = auth.uid() and source_lineage like 'figshare%'
  union all
  select 'dose1-moaas', count(*)::bigint, count(distinct case_ref)::bigint
  from public.external_spectral_epochs
  where user_id = auth.uid() and source_lineage like '%dose-i%' and label is not null
  union all
  select 'bids-events', count(*)::bigint, count(distinct case_ref)::bigint
  from public.external_spectral_epochs
  where user_id = auth.uid() and source_lineage like '%ds004541%' and label is not null
  union all
  select 'generic-bis', count(*)::bigint, count(distinct session_id)::bigint
  from public.bis_paired_points
  where user_id = auth.uid() and context = 'reference upload'
  union all
  select 'generic-moaas', count(*)::bigint, count(distinct session_id)::bigint
  from public.depth_state_labels
  where user_id = auth.uid() and note like '%MOAA/S%'
  union all
  select 'generic-events', count(*)::bigint, count(distinct session_id)::bigint
  from public.depth_state_labels
  where user_id = auth.uid() and (note is null or note not like '%MOAA/S%');
$$;

grant execute on function public.reference_coverage() to authenticated;
grant execute on function public.reference_coverage() to service_role;