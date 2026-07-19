create table users (
  id text primary key,
  active boolean not null
);

create table audit_events (
  id text primary key,
  user_id text references users(id)
);
