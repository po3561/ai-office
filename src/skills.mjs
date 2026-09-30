// 스킬(SKILL.md)·에이전트(.md) 머리말 읽기와 스킬트리 수집, 설정 변경 이력(CSV) 읽기
// 이 모듈은 폴더를 "읽기만" 한다. Hermes(라피스) 같은 외부 봇 폴더도 이 함수로 읽는다.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readText, readJson, isDir } from './util.mjs';

const unq = (s) => String(s ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');

export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = { meta: {}, bodyStart: 0 };
  if (!m) return out;
  out.bodyStart = m[0].length;
  let inMeta = false, last = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      inMeta = top[1] === 'metadata';
      last = inMeta ? null : top[1];
      if (!inMeta) out[top[1]] = unq(top[2]);
      continue;
    }
    const sub = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (inMeta && sub) out.meta[sub[1]] = unq(sub[2]);
    else if (!inMeta && last && /^\s+\S/.test(line)) out[last] = `${out[last]} ${line.trim()}`.trim();
  }
  return out;
}

const iso = (ms) => new Date(ms).toISOString();

function skillFrom(file, folderName, category) {
  let text = '';
  try { text = readText(file); } catch { return null; }
  const fm = parseFrontmatter(text);
  const st = statSync(file);
  const tag = /^\[?\s*([^,\]]+)/.exec(fm.meta.tags || '');
  // 스킬 마켓에서 받은 스킬이면 출처를 함께 보여 준다(.market-installed.json).
  const mk = readJson(join(file, '..', '.market-installed.json'), null);
  return {
    market: mk && mk.schema === 1 ? { id: String(mk.id || ''), version: String(mk.version || ''), publisher: String(mk.publisher || '') } : null,
    id: folderName,
    name: fm.name || folderName,
    description: fm.description || '',
    category: fm.meta.category || category || (tag ? tag[1].trim() : '') || '기타',
    createdBy: fm.meta['created-by'] || '',
    request: fm.meta.request || '',
    created: fm.meta.created || iso(st.birthtimeMs || st.mtimeMs).slice(0, 10),
    updatedAt: iso(st.mtimeMs),
  };
}

export function scanSkills(dir) {
  if (!isDir(dir)) return [];
  const out = [];
  const walk = (d, depth, cat) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const sub = join(d, e.name);
      const file = join(sub, 'SKILL.md');
      if (existsSync(file)) { const s = skillFrom(file, e.name, cat); if (s) out.push(s); }
      else if (depth < 1) walk(sub, depth + 1, e.name);   // 분류 폴더 한 단계까지
    }
  };
  walk(dir, 0, '');
  return out.sort((a, b) => a.category.localeCompare(b.category, 'ko') || a.name.localeCompare(b.name, 'ko'));
}

// 변경 이력 CSV: 날짜,구분,이름,내용,요청
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

export function readChanges(folder, limit = 20) {
  const f = join(folder, '업무데이터', '맞춤설정', '변경이력.csv');
  if (!existsSync(f)) return [];
  try {
    const [, ...rows] = parseCsv(readText(f));
    return rows.map((r) => ({ date: r[0] || '', type: r[1] || '', name: r[2] || '', summary: r[3] || '', request: r[4] || '' }))
      .filter((r) => r.date || r.name).reverse().slice(0, limit);
  } catch { return []; }
}
