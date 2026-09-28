-- 每日一句（Today's Whisper）：VPS 上的沐每天凌晨写一句，首页读当天（或最近）那条

create table if not exists whispers (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  content text not null,
  created_at timestamptz default now()
);
