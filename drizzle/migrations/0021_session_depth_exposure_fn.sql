-- Per-case depth exposure computed in the database so the dashboard never has
-- to page thousands of epoch rows through the API.
create or replace function public.session_depth_exposure(_session_ids uuid[])
returns table (session_id uuid, epochs bigint, mean_depth numeric, deep_epochs bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select e.session_id,
         count(e.depth_index) as epochs,
         avg(e.depth_index) as mean_depth,
         count(*) filter (where e.depth_index < 40) as deep_epochs
  from public.eeg_epochs e
  where e.session_id = any(_session_ids)
    and e.depth_index is not null
  group by e.session_id
$$;

grant execute on function public.session_depth_exposure(uuid[]) to authenticated;
grant execute on function public.session_depth_exposure(uuid[]) to service_role;