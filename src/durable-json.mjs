// Synchronous read/modify/write transactions stay serialized on the Node event loop.
// Keep the last valid document and damaged evidence before accepting a repair.
import { existsSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, HttpError } from './util.mjs';

export function readDurableJson(file, valid) {
  const current = readJson(file, null);
  if (valid(current)) return { value: current, status: 'valid' };
  const previous = readJson(`${file}.previous`, null);
  if (valid(previous)) return { value: previous, status: 'previous-valid' };
  return { value: null, status: existsSync(file) ? 'damaged' : 'missing' };
}
export function writeDurableJson(file, value, valid) {
  if (!valid(value)) throw new HttpError(409, '저장할 설정 형식이 올바르지 않습니다.');
  const current = readJson(file, null);
  if (valid(current)) writeJson(`${file}.previous`, current);
  else if (existsSync(file)) copyFileSync(file, `${file}.damaged-${randomUUID()}`);
  writeJson(file, value);
}
