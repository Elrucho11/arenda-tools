-- =========================================================
--  АрендаСтрой · Инструмент — настройка общей базы Supabase
--  Выполнить ОДИН раз: Supabase → SQL Editor → New query → вставить → Run
-- =========================================================

-- Таблица инструментов (вся карточка хранится как JSON в поле doc)
create table if not exists public.tools (
  id         text primary key,
  doc        jsonb not null,
  sort       int4 default 0,
  updated_at timestamptz not null default now()
);

-- Доступ для приложения через публичный ключ anon
alter table public.tools enable row level security;

drop policy if exists "app full access" on public.tools;
create policy "app full access" on public.tools
  for all to anon, authenticated using (true) with check (true);

grant all on public.tools to anon, authenticated;

-- Мгновенные обновления на всех устройствах (realtime).
-- Если выдаст "table is already member" — это нормально, просто игнорируйте.
alter publication supabase_realtime add table public.tools;
