-- Mitteilungen: einmal im Supabase SQL Editor ausführen (nachdem die Funktion "mitteilungen" angelegt ist).

-- Push-Abos: ein Eintrag pro Gerät
create table if not exists public.push_abos (
  endpoint    text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  tz          text not null default 'Europe/Berlin',
  daily       boolean not null default true,
  streak      boolean not null default true,
  last_daily  date,
  last_streak date,
  created_at  timestamptz not null default now()
);
alter table public.push_abos enable row level security;
create policy "eigene Abos lesen"   on public.push_abos for select using (auth.uid() = user_id);
create policy "eigene Abos anlegen" on public.push_abos for insert with check (auth.uid() = user_id);
create policy "eigene Abos aendern" on public.push_abos for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "eigene Abos loeschen" on public.push_abos for delete using (auth.uid() = user_id);
grant select, insert, update, delete on public.push_abos to authenticated;

-- Schlüssel für den Versand: RLS an und KEINE Policy → nur die Server-Funktion kommt dran
create table if not exists public.push_config (
  id          int primary key default 1,
  public_key  text not null,
  private_jwk jsonb not null
);
alter table public.push_config enable row level security;

-- Stündlicher Zeitplan: die Funktion prüft selbst, wo es gerade 7:00 bzw. 20:00 Uhr ist
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'italiano-mitteilungen',
  '0 * * * *',
  $$ select net.http_post(
       url := 'https://xxhywrqthnjpmhkyqcog.supabase.co/functions/v1/mitteilungen?action=cron',
       -- öffentlicher anon-Key (kein Geheimnis), nötig weil die Funktion einen gültigen JWT verlangt
       headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4aHl3cnF0aG5qcG1oa3lxY29nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU3MTc2NTAsImV4cCI6MjExMTI5MzY1MH0.157brL98UQQOBLYj3l0ZrnJK9wWIsL0h8IKOlx8N_H8"}'::jsonb,
       body := '{}'::jsonb
     ) $$
);
