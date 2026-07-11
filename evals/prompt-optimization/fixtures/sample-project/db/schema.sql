create table projects (
  id integer primary key,
  name text not null
);

create table tasks (
  id integer primary key,
  project_id integer not null,
  title text not null
);
