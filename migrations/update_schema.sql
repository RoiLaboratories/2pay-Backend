-- Drop existing table
DROP TABLE IF EXISTS contributions CASCADE;

-- Recreate table with correct column type
create table contributions (
    id bigint primary key generated always as identity,
    user_address text not null,
    pool_id bigint references pools(id) not null,
    batch_number integer not null,
    amount bigint not null,
    transaction_hash text not null,
    status text not null default 'pending' check (status in ('pending', 'paid')),
    network text not null,
    environment text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Recreate indexes
create index contributions_user_address_idx on contributions(user_address);
create index contributions_pool_id_idx on contributions(pool_id);
create index contributions_status_idx on contributions(status);
create index contributions_batch_idx on contributions(pool_id, batch_number);

-- Enable RLS
alter table contributions enable row level security;

-- Recreate policies
create policy "Users can view their own contributions"
    on contributions for select
    using (user_address = auth.uid()::text);

create policy "Users can create their own contributions"
    on contributions for insert
    with check (user_address = auth.uid()::text);

create policy "Contract can update contribution status"
    on contributions for update
    using (true)
    with check (true);
