create table if not exists public.sef_alignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  gain numeric not null,
  "offset" numeric not null,
  n_points integer not null default 0,
  n_sessions integer not null default 0,
  bias_before numeric,
  bias_after numeric,
  mae_before numeric,
  mae_after numeric,
  auto_applied boolean not null default true,
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.sef_alignments to authenticated;
grant all on public.sef_alignments to service_role;
alter table public.sef_alignments enable row level security;
create policy "own sef alignments select" on public.sef_alignments for select to authenticated using (auth.uid() = user_id);
create policy "own sef alignments insert" on public.sef_alignments for insert to authenticated with check (auth.uid() = user_id);
create policy "own sef alignments update" on public.sef_alignments for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own sef alignments delete" on public.sef_alignments for delete to authenticated using (auth.uid() = user_id);
create index if not exists sef_alignments_user_created_idx on public.sef_alignments (user_id, created_at desc);