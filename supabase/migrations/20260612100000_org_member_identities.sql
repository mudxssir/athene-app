-- P2-1: org_member_identities
-- Maps org_member UUIDs to external provider identities.
-- Used by StructuredOwner lookup to replace the email-prefix heuristic.

create table if not exists org_member_identities (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  member_id      uuid not null references org_members(id) on delete cascade,
  provider       text not null,  -- e.g. 'github', 'linear', 'jira', 'zendesk', 'slack'
  external_id    text not null,  -- provider-native user id
  external_email text,           -- provider email (may differ from auth email)
  display_name   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint uq_org_member_identity unique (org_id, provider, external_id)
);

create index if not exists idx_omi_org_provider on org_member_identities (org_id, provider);
create index if not exists idx_omi_member on org_member_identities (member_id);
create index if not exists idx_omi_external_email on org_member_identities (org_id, external_email) where external_email is not null;

-- updated_at trigger
create or replace function set_omi_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_omi_updated_at on org_member_identities;
create trigger trg_omi_updated_at
  before update on org_member_identities
  for each row execute function set_omi_updated_at();

-- RLS: follow app_setting() pattern used throughout the codebase
alter table org_member_identities enable row level security;

create policy "org_members_read_identities" on org_member_identities
  for select using (
    (org_id)::text = app_setting('org_id')
  );

create policy "org_admins_write_identities" on org_member_identities
  for all using (
    (org_id)::text = app_setting('org_id')
    and app_setting('user_role') in ('admin', 'super_user')
  );
