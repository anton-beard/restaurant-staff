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
  {
    name: '002_tasks',
    sql: `
      create table task_templates (
        id integer primary key autoincrement,
        title text not null,
        description text not null default '',
        requires_photo integer not null default 0,
        photo_criteria text,
        auto_accept_threshold integer not null default 80,
        assignee_mode text not null check (assignee_mode in ('by_position', 'by_employees')),
        distribution text not null check (distribution in ('each', 'shared')),
        schedule_kind text not null check (schedule_kind in ('once', 'weekly', 'interval')),
        schedule text,
        deadline_minutes integer not null,
        next_run_at text,
        active integer not null default 1,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      create table task_template_positions (
        template_id integer not null references task_templates(id) on delete cascade,
        position_id integer not null references positions(id),
        primary key (template_id, position_id)
      );

      create table task_template_employees (
        template_id integer not null references task_templates(id) on delete cascade,
        employee_id integer not null references employees(id),
        primary key (template_id, employee_id)
      );

      create table task_instances (
        id integer primary key autoincrement,
        template_id integer not null references task_templates(id),
        employee_id integer references employees(id),
        slot_at text not null,
        issued_at text not null,
        due_at text not null,
        claimed_at text,
        status text not null
          check (status in ('open', 'pending', 'submitted', 'review', 'accepted', 'overdue')),
        completed_at text,
        reminder_sent_at text
      );
      create unique index task_instances_each
        on task_instances(template_id, slot_at, employee_id) where employee_id is not null;
      create unique index task_instances_shared
        on task_instances(template_id, slot_at) where employee_id is null;
      create index task_instances_status on task_instances(status, due_at);

      create table task_offers (
        id integer primary key autoincrement,
        instance_id integer not null references task_instances(id) on delete cascade,
        telegram_id integer not null,
        message_id integer not null
      );

      create table task_submissions (
        id integer primary key autoincrement,
        instance_id integer not null references task_instances(id),
        created_at text not null,
        ai_status text not null default 'pending' check (ai_status in ('pending', 'done', 'failed')),
        ai_attempts integer not null default 0,
        ai_score integer,
        ai_verdict text,
        ai_issues text not null default '[]',
        decision text check (decision in ('auto_accepted', 'needs_review', 'owner_accepted', 'owner_rejected')),
        owner_comment text,
        decided_at text
      );

      create table task_photos (
        id integer primary key autoincrement,
        submission_id integer not null references task_submissions(id) on delete cascade,
        position integer not null,
        path text not null,
        telegram_file_unique_id text not null unique,
        deleted_at text
      );
    `,
  },
]
