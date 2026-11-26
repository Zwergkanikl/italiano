-- Einmal in Supabase ausführen: SQL Editor → New query → einfügen → Run.
-- Legt eine Tabelle an, in der pro Nutzer der komplette Lernstand liegt.
-- Row Level Security sorgt dafür, dass jeder nur seine eigenen Daten sieht.

create table if not exists public.lernstand (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.lernstand enable row level security;

create policy "eigene Daten lesen"   on public.lernstand for select using (auth.uid() = user_id);
create policy "eigene Daten anlegen" on public.lernstand for insert with check (auth.uid() = user_id);
create policy "eigene Daten ändern"  on public.lernstand for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update on public.lernstand to authenticated;
