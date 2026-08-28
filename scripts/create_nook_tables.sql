-- 共读功能（Nook）表结构

create table if not exists nook_books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text,
  translator text,
  total_chapters integer,
  parts jsonb,
  created_at timestamptz default now()
);

create table if not exists nook_chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references nook_books(id),
  chapter_number integer not null,
  title text not null,
  content text not null,
  unique(book_id, chapter_number)
);

create table if not exists nook_progress (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references nook_books(id),
  who text not null check (who in ('hua', 'mu')),
  chapter integer not null default 1,
  paragraph integer not null default 0,
  updated_at timestamptz default now(),
  unique(book_id, who)
);

create table if not exists nook_annotations (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references nook_books(id),
  chapter integer not null,
  anchor_para integer not null,
  anchor_quote text not null,
  who text not null check (who in ('hua', 'mu')),
  created_at timestamptz default now()
);

create table if not exists nook_annotation_floors (
  id uuid primary key default gen_random_uuid(),
  annotation_id uuid references nook_annotations(id),
  who text not null check (who in ('hua', 'mu')),
  text text not null,
  created_at timestamptz default now()
);

create index if not exists idx_nook_chapters_book on nook_chapters(book_id);
create index if not exists idx_nook_annotations_book_chapter on nook_annotations(book_id, chapter);
create index if not exists idx_nook_annotation_floors_annotation on nook_annotation_floors(annotation_id);
