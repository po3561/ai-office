// 프로그램 설정(config.json)
import { FILES } from './paths.mjs';
import { readJson, writeJson, need } from './util.mjs';

export const DEFAULTS = { port: 3300, honorific: '사용자님', theme: 'auto', autoRestart: true };

export const getConfig = () => ({ ...DEFAULTS, ...readJson(FILES.config, {}) });

export function setConfig(patch = {}) {
  const cur = getConfig();
  const next = { ...cur };
  if ('port' in patch) {
    const p = Number(patch.port);
    need(Number.isInteger(p) && p >= 1024 && p <= 65535, '포트는 1024~65535 사이 숫자여야 합니다.');
    next.port = p;
  }
  if ('honorific' in patch) {
    const h = String(patch.honorific || '').trim();
    need(h.length >= 1 && h.length <= 20 && !/[<>&"\n\r]/.test(h), '호칭은 1~20자, 특수기호(<>&")는 쓸 수 없습니다.');
    next.honorific = h;
  }
  if ('theme' in patch) {
    need(['auto', 'light', 'dark'].includes(patch.theme), '테마는 auto, light, dark 중 하나입니다.');
    next.theme = patch.theme;
  }
  if ('autoRestart' in patch) next.autoRestart = Boolean(patch.autoRestart);
  writeJson(FILES.config, next);
  return next;
}
