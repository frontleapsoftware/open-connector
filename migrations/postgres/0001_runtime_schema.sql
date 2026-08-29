-- Consolidated runtime schema for PostgreSQL (matches SQLite/D1 after migrations 0001–0010).

create table if not exists schema_migrations (
  id text primary key,
  applied_at text not null
);

create table if not exists connections (
  id text not null unique,
  revision text not null default '',
  service text not null,
  connection_name text not null,
  value text not null,
  updated_at text not null,
  primary key (service, connection_name)
);

create table if not exists oauth_client_configs (
  service text primary key,
  value text not null,
  updated_at text not null
);

create table if not exists oauth_states (
  state text primary key,
  value text not null,
  created_at text not null
);

create table if not exists runtime_tokens (
  id text primary key,
  name text not null,
  token_hash text not null unique,
  allowed_actions text not null default '[]',
  blocked_actions text not null default '[]',
  allowed_proxies text not null default '[]',
  created_at text not null,
  last_used_at text,
  revoked_at text
);

create table if not exists runtime_policy (
  id integer primary key check (id = 1),
  value text not null,
  updated_at text not null
);

create table if not exists runs (
  id text primary key,
  service text,
  action_id text not null,
  caller text,
  started_at text not null,
  completed_at text not null,
  ok integer not null,
  value text not null
);

create index if not exists runs_service_started_at_id_idx on runs (service, started_at desc, id desc);
create index if not exists runs_action_id_started_at_id_idx on runs (action_id, started_at desc, id desc);
create index if not exists runs_caller_started_at_id_idx on runs (caller, started_at desc, id desc);
create index if not exists runs_ok_started_at_id_idx on runs (ok, started_at desc, id desc);

create table if not exists idempotency_records (
  key_hash text primary key,
  claim_id text not null,
  request_hash text not null,
  state text not null check (state in ('in_progress', 'completed')),
  response_value text,
  created_at text not null,
  expires_at text not null,
  check (
    (state = 'in_progress' and response_value is null)
    or (state = 'completed' and response_value is not null)
  )
);

create index if not exists idempotency_records_expires_at_idx on idempotency_records (expires_at);
