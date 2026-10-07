import { join } from 'node:path';
import { existsSync, readdirSync, mkdirSync, copyFileSync, lstatSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readJson, writeJson, isDir, need } from './util.mjs';
import { loadOffice } from './teams.mjs';
import { readDurableJson } from './durable-json.mjs';

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function snapshotUserData(dataHome, dest) {
  const files = [];
  mkdirSync(dest, { recursive: true });
  function capture(path) {
    if (!existsSync(path)) return;
    const st = lstatSync(path);
    need(!st.isSymbolicLink(), '사용자 데이터 스냅샷에 연결 경로가 있어 업데이트를 중단했습니다.', 409);
    if (st.isDirectory()) { for (const name of readdirSync(path)) capture(join(path, name)); return; }
    if (!st.isFile()) return;
    const backup = `file-${files.length}`;
    copyFileSync(path, join(dest, backup)); files.push({ source: path, backup, sha256: digest(path) });
  }
  if (isDir(dataHome)) for (const f of readdirSync(dataHome)) if (/\.(json|bin)$/.test(f) && f !== 'install.json') capture(join(dataHome, f));
  capture(join(dataHome, 'usage'));
  const registry = readDurableJson(join(dataHome, 'offices.json'), r => r && Array.isArray(r.offices));
  need(registry.value || registry.status === 'missing', '사무실 등록부가 손상되어 업데이트를 중단했습니다.', 409);
  const offices = (registry.value?.offices || []).map(o => {
    const available = isDir(o.folder);
    if (available) for (const f of ['.ai-office', '.claude/agents', '.claude/settings.json', '.claude/settings.local.json']) capture(join(o.folder, f));
    return { id: o.id, folder: o.folder, kind: o.kind, available, teamKeys: available && o.kind !== 'hermes' ? loadOffice(o.folder).teams.map(t => t.key).sort() : [] };
  });
  const bots = join(dataHome, 'bots');
  if (isDir(bots)) for (const id of readdirSync(bots)) capture(join(bots, id, 'bot.json'));
  const manifest = { version: 1, at: new Date().toISOString(), offices, files };
  writeJson(join(dest, 'manifest.json'), manifest); return manifest;
}
export function verifyUserData(manifest) {
  for (const f of manifest.files) need(existsSync(f.source) && digest(f.source) === f.sha256, '사용자 데이터가 변경되어 업데이트 성공으로 기록하지 않았습니다. 복구 스냅샷을 확인해 주세요.', 409);
  for (const o of manifest.offices) {
    need(isDir(o.folder) === o.available, '사무실 연결 상태가 업데이트 중 변경되었습니다.', 409);
    if (o.available && o.kind !== 'hermes') need(JSON.stringify(loadOffice(o.folder).teams.map(t => t.key).sort()) === JSON.stringify(o.teamKeys), '부서 목록 대조에 실패했습니다.', 409);
  }
  return { verified: true, offices: manifest.offices.length, files: manifest.files.length };
}
