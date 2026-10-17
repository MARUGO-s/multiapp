-- Local-only stand-ins for unrelated Supabase Auth/Storage/shared-login tables.
-- QR tables and RPCs below are always created by the actual migration files.
create role anon;
create role authenticated;
create role service_role;
create schema kotonoha;
create schema auth;
create schema storage;
grant usage on schema kotonoha, public to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
create table auth.users (
  id uuid primary key, email text, email_confirmed_at timestamptz,
  deleted_at timestamptz, banned_until timestamptz,
  raw_user_meta_data jsonb not null default '{}'
);
insert into auth.users(id,email,email_confirmed_at) values
  ('00000000-0000-4000-8000-000000000071','pingus0428@gmail.com',now());
create table kotonoha.access_config (
  singleton boolean primary key default true,
  workspace_id uuid not null
);
insert into kotonoha.access_config(workspace_id) values ('00000000-0000-4000-8000-000000000072');
create table kotonoha.sessions (
  token_hash text primary key, expires_at timestamptz, google_user_id uuid
);
