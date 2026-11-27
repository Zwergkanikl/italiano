-- Einmal in Supabase ausführen: SQL Editor → New query → einfügen → Run.
-- Legt einen privaten Speicher ("Bucket") für die Fotos der Buchseiten an.
-- Jeder Nutzer darf nur in seinem eigenen Ordner (= seine User-ID) lesen, speichern und löschen.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('seiten', 'seiten', false, 10485760, array['image/jpeg'])
on conflict (id) do nothing;

create policy "seiten lesen"    on storage.objects for select to authenticated
  using (bucket_id = 'seiten' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "seiten anlegen"  on storage.objects for insert to authenticated
  with check (bucket_id = 'seiten' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "seiten ändern"   on storage.objects for update to authenticated
  using (bucket_id = 'seiten' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'seiten' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "seiten löschen"  on storage.objects for delete to authenticated
  using (bucket_id = 'seiten' and (storage.foldername(name))[1] = auth.uid()::text);
