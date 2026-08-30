create table if not exists public.sudoku_rooms (
  room_id text primary key,
  shared_state jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_sudoku_room_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists sudoku_rooms_set_updated_at on public.sudoku_rooms;

create trigger sudoku_rooms_set_updated_at
before update on public.sudoku_rooms
for each row
execute function public.set_sudoku_room_updated_at();

alter table public.sudoku_rooms enable row level security;

drop policy if exists "anon can read sudoku rooms" on public.sudoku_rooms;
create policy "anon can read sudoku rooms"
on public.sudoku_rooms
for select
to anon
using (true);

drop policy if exists "anon can insert sudoku rooms" on public.sudoku_rooms;
create policy "anon can insert sudoku rooms"
on public.sudoku_rooms
for insert
to anon
with check (true);

drop policy if exists "anon can update sudoku rooms" on public.sudoku_rooms;
create policy "anon can update sudoku rooms"
on public.sudoku_rooms
for update
to anon
using (true)
with check (true);

alter publication supabase_realtime add table public.sudoku_rooms;
