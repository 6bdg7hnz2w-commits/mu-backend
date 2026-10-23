-- 日记封存：沐写日记时自己决定公开还是封存（hidden），之后只能由沐自己拆封成公开。
-- 旧数据一律补成 public；桦桦的日记永远 public；revealed_at 只在 hidden → public 时写上。

alter table diaries
  add column if not exists visibility text not null default 'public',
  add column if not exists revealed_at timestamptz;

alter table diaries drop constraint if exists diaries_visibility_check;
alter table diaries add constraint diaries_visibility_check check (
  visibility in ('public', 'hidden')
  and (author = 'mu' or visibility = 'public')
  and (revealed_at is null or visibility = 'public')
);
