-- =====================================================================
-- backend/supabase.sql
-- Inspeções - Infra | EDP Transmissão Construção
-- ---------------------------------------------------------------------
-- Base central multiusuário: autenticação, perfis com lotes de atuação,
-- inspeções, histórico de versões e fotos.
--
-- COMO EXECUTAR
--   1. Crie o projeto em supabase.com.
--   2. SQL Editor > New query > cole este arquivo inteiro > Run.
--   3. Siga a seção "PRIMEIRO ADMINISTRADOR" no fim do arquivo.
--
-- O script é idempotente: pode ser executado novamente sem quebrar.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. EXTENSÕES
-- ---------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. TABELA DE USUÁRIOS (perfil vinculado a auth.users)
-- ---------------------------------------------------------------------
create table if not exists public.usuarios (
  id            uuid primary key references auth.users(id) on delete cascade,
  nome          text not null,
  email         text not null unique,
  funcao        text not null,                       -- Consultor | Analista | Especialista | Gestor | Outro
  lotes         text[] not null default '{}',        -- {'TN02','TN13'}
  perfil        text not null default 'inspetor',    -- inspetor | admin
  status        text not null default 'pendente',    -- pendente | ativo | inativo | recusado
  criado_em     timestamptz not null default now(),
  ultimo_acesso timestamptz,
  ultimo_sync   timestamptz,
  dispositivo   text,
  constraint usuarios_perfil_valido check (perfil in ('inspetor', 'admin')),
  constraint usuarios_status_valido check (status in ('pendente', 'ativo', 'inativo', 'recusado'))
);

comment on table  public.usuarios is 'Perfil do inspetor. O cadastro nasce como pendente e só acessa após aprovação do administrador.';
comment on column public.usuarios.lotes is 'Lotes que o usuário pode ver e gravar. A RLS usa esta coluna — não é validação de tela.';

create index if not exists idx_usuarios_status on public.usuarios (status);
create index if not exists idx_usuarios_lotes  on public.usuarios using gin (lotes);

-- ---------------------------------------------------------------------
-- 2. TABELA DE INSPEÇÕES
-- ---------------------------------------------------------------------
create table if not exists public.inspecoes (
  id                  bigint generated always as identity primary key,
  id_local            uuid not null unique,          -- UUID gerado no aparelho (idempotência)
  usuario_id          uuid not null references public.usuarios(id) on delete restrict,
  responsavel         text not null,                 -- nome gravado no momento da inspeção
  funcao_responsavel  text,
  data_inspecao       date not null,
  lote                text not null,
  canteiro            text not null,
  construtora         text not null,
  o_que_inspecionado  text[] not null default '{}',
  nao_conformidade    boolean not null default false,
  quais               text,
  observacoes         text,
  latitude            double precision,
  longitude           double precision,
  precisao_gps        integer,
  dispositivo         text,
  fotos               jsonb not null default '[]'::jsonb,   -- [{caminho, legenda, ordem, bytes}]
  qtd_fotos           integer not null default 0,
  versao              integer not null default 1,
  criado_em           timestamptz not null,
  atualizado_em       timestamptz not null,
  excluido            boolean not null default false,
  motivo_exclusao     text,
  excluido_em         timestamptz,
  recebido_em         timestamptz not null default now(),
  constraint inspecoes_nc_descrita
    check (nao_conformidade = false or coalesce(length(trim(quais)), 0) > 0)
);

comment on table  public.inspecoes is 'Base central de inspeções — uma linha por inspeção realizada, de qualquer aparelho.';
comment on column public.inspecoes.id_local is 'UUID do aparelho. Chave do upsert: reenviar o mesmo registro atualiza, nunca duplica.';
comment on constraint inspecoes_nc_descrita on public.inspecoes is 'Espelha no servidor a regra da tela: NC = Sim exige a descrição em "quais".';

create index if not exists idx_inspecoes_lote      on public.inspecoes (lote);
create index if not exists idx_inspecoes_data      on public.inspecoes (data_inspecao desc);
create index if not exists idx_inspecoes_usuario   on public.inspecoes (usuario_id);
create index if not exists idx_inspecoes_canteiro  on public.inspecoes (canteiro);
create index if not exists idx_inspecoes_nc        on public.inspecoes (nao_conformidade) where nao_conformidade;
create index if not exists idx_inspecoes_ativas    on public.inspecoes (data_inspecao desc) where not excluido;

-- ---------------------------------------------------------------------
-- 3. HISTÓRICO DE VERSÕES
-- ---------------------------------------------------------------------
create table if not exists public.inspecoes_historico (
  id            bigint generated always as identity primary key,
  id_local      uuid not null,
  usuario_id    uuid,
  lote          text,
  versao        integer,
  conteudo      jsonb not null,
  motivo        text,                                 -- 'edicao' | 'edicao-ignorada'
  arquivado_em  timestamptz not null default now()
);

create index if not exists idx_hist_id_local on public.inspecoes_historico (id_local);

-- ---------------------------------------------------------------------
-- 4. FUNÇÕES AUXILIARES DE AUTORIZAÇÃO
-- ---------------------------------------------------------------------
-- SECURITY DEFINER + search_path fixo: as funções leem public.usuarios
-- sem esbarrar na própria RLS (evita recursão infinita nas políticas).

create or replace function public.eh_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = auth.uid()
      and u.perfil = 'admin'
      and u.status = 'ativo'
  );
$$;

create or replace function public.usuario_ativo()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = auth.uid() and u.status = 'ativo'
  );
$$;

/* Lotes do usuário autenticado. Base de toda a segregação. */
create or replace function public.meus_lotes()
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select u.lotes from public.usuarios u
      where u.id = auth.uid() and u.status = 'ativo'),
    '{}'::text[]
  );
$$;

/* Status e perfil do próprio usuário, sem passar pela RLS da tabela
   (usar uma subconsulta direta dentro da política causaria recursão). */
create or replace function public.meu_status()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select u.status from public.usuarios u where u.id = auth.uid();
$$;

create or replace function public.meu_perfil()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select u.perfil from public.usuarios u where u.id = auth.uid();
$$;

/* O lote informado está entre os lotes do usuário? Admin: sempre sim. */
create or replace function public.pode_no_lote(p_lote text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.eh_admin() or (p_lote = any (public.meus_lotes()));
$$;

-- ---------------------------------------------------------------------
-- 5. GATILHOS
-- ---------------------------------------------------------------------

/* 5.1 Arquiva a versão anterior e resolve o conflito de edição.
       Regra: prevalece o registro com atualizado_em MAIS RECENTE.
       Uma atualização mais antiga que a gravada é descartada (o servidor
       mantém o que já tinha), mas fica registrada no histórico. */
create or replace function public.fn_inspecao_versionar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.inspecoes_historico (id_local, usuario_id, lote, versao, conteudo, motivo)
  values (old.id_local, old.usuario_id, old.lote, old.versao, to_jsonb(old),
          case when new.atualizado_em < old.atualizado_em then 'edicao-ignorada' else 'edicao' end);

  if new.atualizado_em < old.atualizado_em then
    -- Chegou uma versão mais antiga (aparelho atrasado): mantém a atual.
    return old;
  end if;

  new.qtd_fotos := coalesce(jsonb_array_length(new.fotos), 0);
  new.recebido_em := now();
  return new;
end;
$$;

drop trigger if exists trg_inspecao_versionar on public.inspecoes;
create trigger trg_inspecao_versionar
  before update on public.inspecoes
  for each row execute function public.fn_inspecao_versionar();

/* 5.2 Coerência na inserção: usuario_id sempre é quem está autenticado
       e qtd_fotos é derivada — o cliente não escolhe nenhum dos dois. */
create or replace function public.fn_inspecao_inserir()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.usuario_id := auth.uid();
  new.qtd_fotos  := coalesce(jsonb_array_length(new.fotos), 0);
  new.recebido_em := now();
  return new;
end;
$$;

drop trigger if exists trg_inspecao_inserir on public.inspecoes;
create trigger trg_inspecao_inserir
  before insert on public.inspecoes
  for each row execute function public.fn_inspecao_inserir();

/* 5.3 Carimba o último acesso do usuário a cada sincronização. */
create or replace function public.fn_marcar_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.usuarios
     set ultimo_sync = now(),
         ultimo_acesso = greatest(coalesce(ultimo_acesso, now()), now()),
         dispositivo = coalesce(new.dispositivo, dispositivo)
   where id = auth.uid();
  return null;
end;
$$;

drop trigger if exists trg_marcar_sync on public.inspecoes;
create trigger trg_marcar_sync
  after insert or update on public.inspecoes
  for each row execute function public.fn_marcar_sync();

-- ---------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.usuarios            enable row level security;
alter table public.inspecoes           enable row level security;
alter table public.inspecoes_historico enable row level security;

-- ---- 6.1 usuarios --------------------------------------------------
-- Cada um enxerga o próprio cadastro; o administrador enxerga todos.
drop policy if exists "usuario le o proprio cadastro" on public.usuarios;
create policy "usuario le o proprio cadastro"
  on public.usuarios for select
  to authenticated
  using (id = auth.uid() or public.eh_admin());

-- O cadastro é criado pelo próprio usuário logo após o signup, sempre
-- como 'pendente' e 'inspetor'. Ninguém se aprova nem se promove.
drop policy if exists "usuario cria o proprio cadastro" on public.usuarios;
create policy "usuario cria o proprio cadastro"
  on public.usuarios for insert
  to authenticated
  with check (
    id = auth.uid()
    and status = 'pendente'
    and perfil = 'inspetor'
  );

-- Atualização pelo próprio: apenas dados descritivos. Status, perfil e
-- lotes ficam congelados (WITH CHECK compara com a linha existente).
drop policy if exists "usuario atualiza dados proprios" on public.usuarios;
create policy "usuario atualiza dados proprios"
  on public.usuarios for update
  to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and status = public.meu_status()
    and perfil = public.meu_perfil()
    and lotes  = public.meus_lotes()
  );

-- Administrador: acesso total ao cadastro (aprovar, editar lotes,
-- promover, desativar).
drop policy if exists "admin administra usuarios" on public.usuarios;
create policy "admin administra usuarios"
  on public.usuarios for all
  to authenticated
  using (public.eh_admin())
  with check (public.eh_admin());

-- ---- 6.2 inspecoes -------------------------------------------------
-- LEITURA: somente inspeções cujo lote está no lotes[] do usuário.
-- Um usuário do TN13 não enxerga nada do TN02 — decidido no servidor.
drop policy if exists "le inspecoes do meu lote" on public.inspecoes;
create policy "le inspecoes do meu lote"
  on public.inspecoes for select
  to authenticated
  using (public.usuario_ativo() and public.pode_no_lote(lote));

-- GRAVAÇÃO: além do lote, o registro tem de ser do próprio usuário.
drop policy if exists "grava inspecao no meu lote" on public.inspecoes;
create policy "grava inspecao no meu lote"
  on public.inspecoes for insert
  to authenticated
  with check (
    public.usuario_ativo()
    and public.pode_no_lote(lote)
    and usuario_id = auth.uid()
  );

-- EDIÇÃO: o autor edita o que é dele, dentro do seu lote; o
-- administrador edita qualquer registro.
drop policy if exists "edita inspecao do meu lote" on public.inspecoes;
create policy "edita inspecao do meu lote"
  on public.inspecoes for update
  to authenticated
  using (
    public.usuario_ativo()
    and public.pode_no_lote(lote)
    and (usuario_id = auth.uid() or public.eh_admin())
  )
  with check (
    public.pode_no_lote(lote)
    and (usuario_id = auth.uid() or public.eh_admin())
  );

-- Sem política de DELETE: a exclusão é lógica (excluido = true).
-- Nem o administrador apaga fisicamente pela API.

-- ---- 6.3 historico -------------------------------------------------
drop policy if exists "le historico do meu lote" on public.inspecoes_historico;
create policy "le historico do meu lote"
  on public.inspecoes_historico for select
  to authenticated
  using (public.usuario_ativo() and public.pode_no_lote(lote));

-- A gravação do histórico é feita pelo gatilho (security definer),
-- portanto não há política de INSERT para o cliente.

-- ---------------------------------------------------------------------
-- 7. STORAGE — bucket das fotos
-- ---------------------------------------------------------------------
-- Caminho dos arquivos: {lote}/{id_local}/{arquivo}
-- O primeiro segmento do caminho é o LOTE, e é ele que a política usa.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos-inspecao', 'fotos-inspecao', false, 5242880, array['image/jpeg','image/png'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Bucket privado: a leitura passa por URL assinada ou pela sessão do
-- usuário. Se a obra preferir fotos públicas (para consumo direto no
-- Power BI), troque "public" para true acima e mantenha as políticas.

drop policy if exists "envia foto do meu lote" on storage.objects;
create policy "envia foto do meu lote"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'fotos-inspecao'
    and public.pode_no_lote((storage.foldername(name))[1])
  );

drop policy if exists "atualiza foto do meu lote" on storage.objects;
create policy "atualiza foto do meu lote"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'fotos-inspecao'
    and public.pode_no_lote((storage.foldername(name))[1])
  )
  with check (
    bucket_id = 'fotos-inspecao'
    and public.pode_no_lote((storage.foldername(name))[1])
  );

drop policy if exists "le foto do meu lote" on storage.objects;
create policy "le foto do meu lote"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'fotos-inspecao'
    and public.pode_no_lote((storage.foldername(name))[1])
  );

-- ---------------------------------------------------------------------
-- 8. VISÕES PARA RELATÓRIO / POWER BI
-- ---------------------------------------------------------------------
create or replace view public.vw_inspecoes as
select
  i.id_local,
  i.data_inspecao,
  date_trunc('month', i.data_inspecao)::date as competencia,
  i.responsavel,
  i.funcao_responsavel,
  u.email as email_responsavel,
  i.lote,
  i.canteiro,
  i.construtora,
  array_to_string(i.o_que_inspecionado, '; ') as o_que_inspecionado,
  i.nao_conformidade,
  i.quais,
  i.observacoes,
  i.latitude,
  i.longitude,
  i.qtd_fotos,
  i.versao,
  i.criado_em,
  i.atualizado_em
from public.inspecoes i
join public.usuarios u on u.id = i.usuario_id
where i.excluido = false;

comment on view public.vw_inspecoes is 'Inspeções ativas com o e-mail do responsável. Respeita a RLS de quem consulta.';

-- Cobertura por canteiro (útil no acompanhamento e no Power BI)
create or replace view public.vw_cobertura_canteiros as
select
  i.lote,
  i.canteiro,
  count(*)                                              as inspecoes,
  count(*) filter (where i.nao_conformidade)            as com_nc,
  max(i.data_inspecao)                                  as ultima_inspecao,
  current_date - max(i.data_inspecao)                   as dias_desde_ultima
from public.inspecoes i
where i.excluido = false
group by i.lote, i.canteiro;

-- ---------------------------------------------------------------------
-- 9. PRIMEIRO ADMINISTRADOR
-- ---------------------------------------------------------------------
-- Faça o cadastro normalmente pelo aplicativo (ele nasce 'pendente') e
-- depois rode o comando abaixo trocando o e-mail. A partir daí a
-- aprovação dos demais é feita pela tela de Administração do app.
--
--   update public.usuarios
--      set perfil = 'admin',
--          status = 'ativo',
--          lotes  = array['TN02','TM05','TN07','TN13']
--    where email = 'ce142734@gmail.com';
--
-- Conferência rápida das permissões de um usuário:
--   select nome, email, perfil, status, lotes from public.usuarios order by criado_em;
-- =====================================================================
