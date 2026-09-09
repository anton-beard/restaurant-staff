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
  {
    name: '003_learning',
    sql: `
      alter table employees add column linked_at text;
      alter table employees add column position_changed_at text;
      update employees set linked_at = case when telegram_id is not null then created_at else null end,
                           position_changed_at = created_at;

      create table courses (
        id integer primary key autoincrement,
        title text not null,
        description text not null default '',
        due_days integer not null,
        pass_score integer not null default 80,
        status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
        published_at text,
        assign_existing integer not null default 0,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      create table course_positions (
        course_id integer not null references courses(id) on delete cascade,
        position_id integer not null references positions(id),
        primary key (course_id, position_id)
      );
      create table lessons (
        id integer primary key autoincrement,
        course_id integer not null references courses(id) on delete cascade,
        position integer not null,
        title text not null,
        body text not null default '',
        media text not null default '[]',
        unique (course_id, position)
      );
      create table quizzes (
        id integer primary key autoincrement,
        title text not null,
        course_id integer references courses(id) on delete cascade,
        pass_score integer not null default 80,
        schedule text,
        deadline_minutes integer,
        status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
        next_run_at text,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      create unique index quizzes_course on quizzes(course_id) where course_id is not null;
      create table quiz_positions (
        quiz_id integer not null references quizzes(id) on delete cascade,
        position_id integer not null references positions(id),
        primary key (quiz_id, position_id)
      );
      create table questions (
        id integer primary key autoincrement,
        quiz_id integer not null references quizzes(id) on delete cascade,
        position integer not null,
        text text not null,
        options text not null,
        correct_index integer not null,
        unique (quiz_id, position)
      );
      create table course_assignments (
        id integer primary key autoincrement,
        course_id integer not null references courses(id),
        employee_id integer not null references employees(id),
        assigned_at text not null,
        due_at text not null,
        current_lesson integer not null default 1,
        status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'overdue')),
        completed_at text,
        reminder_sent_at text,
        unique (course_id, employee_id)
      );
      create table quiz_assignments (
        id integer primary key autoincrement,
        quiz_id integer not null references quizzes(id),
        employee_id integer not null references employees(id),
        course_assignment_id integer references course_assignments(id),
        slot_at text not null,
        assigned_at text not null,
        due_at text not null,
        status text not null default 'pending' check (status in ('pending', 'passed', 'overdue')),
        passed_at text,
        reminder_sent_at text,
        unique (quiz_id, employee_id, slot_at)
      );
      create table quiz_attempts (
        id integer primary key autoincrement,
        assignment_id integer not null references quiz_assignments(id),
        started_at text not null,
        finished_at text,
        current_question integer not null default 1,
        answers text not null default '[]',
        score integer,
        passed integer
      );
      create index quiz_attempts_open on quiz_attempts(assignment_id) where finished_at is null;
    `,
  },
  {
    name: '004_stats',
    sql: `
      create index task_instances_employee_due on task_instances(employee_id, due_at);
      create index task_instances_issued on task_instances(issued_at);
      create index quiz_attempts_assignment_finished on quiz_attempts(assignment_id, finished_at);
      create index course_assignments_employee on course_assignments(employee_id);
      create index quiz_assignments_employee on quiz_assignments(employee_id);
    `,
  },
]
