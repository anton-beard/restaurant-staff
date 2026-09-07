export type Migration = { name: string; sql: string }

export const migrations: Migration[] = [
  {
    name: '001_init',
    sql: `
      create table positions (
        id integer primary key autoincrement,
        name text not null unique
      );

      create table employees (
        id integer primary key autoincrement,
        full_name text not null,
        phone text not null unique,
        position_id integer not null references positions(id),
        telegram_id integer unique,
        status text not null default 'invited'
          check (status in ('invited', 'active', 'archived')),
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      create table bot_states (
        telegram_id integer primary key,
        state text not null
      );

      create table owner_login_codes (
        id integer primary key autoincrement,
        code_hash text not null,
        expires_at integer not null,
        used integer not null default 0
      );

      create table owner_sessions (
        id integer primary key autoincrement,
        token_hash text not null unique,
        expires_at integer not null
      );

      create table settings (
        key text primary key,
        value text not null
      );
    `,
  },
]
