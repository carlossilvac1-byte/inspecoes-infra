-- =====================================================================
-- 04-tempo-real.sql — TEMPO REAL + SITUAÇÃO DE ENVIO (v4.3.0)
-- ---------------------------------------------------------------------
-- Rode UMA vez no Supabase: SQL Editor > New query > colar > Run.
-- Pode ser executado de novo sem problema.
--
-- 1) Liga o Realtime nas tabelas de inspeções e cronograma: o app do
--    administrador (e de quem tem visão "todas") é avisado no instante
--    em que uma inspeção chega à base. O Realtime respeita as mesmas
--    regras de acesso (RLS) — cada um só é avisado do que pode ver.
-- 2) Cria a coluna "pendentes_envio": cada aparelho informa quantas
--    inspeções ainda estão só nele. Aparece na tela de Liberações.
-- =====================================================================

alter table public.usuarios add column if not exists pendentes_envio int not null default 0;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'inspecoes') then
    alter publication supabase_realtime add table public.inspecoes;
  end if;
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'cronograma')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cronograma') then
    alter publication supabase_realtime add table public.cronograma;
  end if;
end $$;
