// 共读功能：把 data/books/<slug>/ 下的 book.json + ch**.md 灌进 Supabase。
// 用法：node scripts/import_book.js gone-with-the-wind
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const slug = process.argv[2];
if (!slug) {
  console.error('用法: node scripts/import_book.js <书目录名>');
  process.exit(1);
}

const bookDir = path.join(__dirname, '..', 'data', 'books', slug);
const bookJsonPath = path.join(bookDir, 'book.json');

async function ensureTables() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const sql = fs.readFileSync(path.join(__dirname, 'create_nook_tables.sql'), 'utf8');
  await client.query(sql);
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.end();
  console.log('数据表已就绪，等待 PostgREST 刷新 schema 缓存...');
  await new Promise(r => setTimeout(r, 3000));
}

function parseChapterFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const firstNewline = raw.indexOf('\n');
  const firstLine = firstNewline === -1 ? raw : raw.slice(0, firstNewline);
  const title = firstLine.replace(/^#+\s*/, '').trim();
  const content = (firstNewline === -1 ? '' : raw.slice(firstNewline + 1)).trim();
  return { title, content };
}

async function main() {
  await ensureTables();

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const book = JSON.parse(fs.readFileSync(bookJsonPath, 'utf8'));

  const { data: existing } = await supabase
    .from('nook_books').select('id').eq('title', book.title).maybeSingle();

  let bookId;
  if (existing) {
    bookId = existing.id;
    await supabase.from('nook_books').update({
      author: book.author,
      translator: book.translator,
      total_chapters: book.total_chapters,
      parts: book.parts
    }).eq('id', bookId);
    console.log(`已存在书籍《${book.title}》，更新元数据 (id=${bookId})`);
  } else {
    const { data: inserted, error } = await supabase.from('nook_books').insert({
      title: book.title,
      author: book.author,
      translator: book.translator,
      total_chapters: book.total_chapters,
      parts: book.parts
    }).select().single();
    if (error) throw error;
    bookId = inserted.id;
    console.log(`已创建书籍《${book.title}》(id=${bookId})`);
  }

  const files = fs.readdirSync(bookDir)
    .filter(f => /^ch\d+\.md$/.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const file of files) {
    const chapterNumber = parseInt(file.match(/^ch(\d+)\.md$/)[1], 10);
    const { title, content } = parseChapterFile(path.join(bookDir, file));
    const { error } = await supabase.from('nook_chapters').upsert({
      book_id: bookId,
      chapter_number: chapterNumber,
      title,
      content
    }, { onConflict: 'book_id,chapter_number' });
    if (error) throw error;
    console.log(`第${chapterNumber}章《${title}》已导入`);
  }

  console.log(`导入完成，共 ${files.length} 章`);
}

main().catch(err => {
  console.error('导入失败:', err);
  process.exit(1);
});
