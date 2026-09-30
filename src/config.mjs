// 프로그램 설정(config.json)
import { FILES } from './paths.mjs';
import { readJson, writeJson, need } from './util.mjs';
import { normalizeRepo } from './market.mjs';

// market: 스킬 마켓 연결 정보. 토큰은 저장하지 않는다(PC 의 git·gh 로그인을 그대로 쓴다).
export const DEFAULTS = { port: 3300, honorific: '사용자님', theme: 'auto', autoRestart: true, market: { enabled: false, repo: '', alias: '' } };

export const getConfig = () => {
  const c = { ...DEFAULTS, ...readJson(FILES.config, {}) };
  c.market = { ...DEFAULTS.market, ...(c.market && typeof c.market === 'object' ? c.market : {}) };
  return c;
};

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
  if ('market' in patch) {
    const m = patch.market || {};
    const nm = { ...cur.market };
    if ('repo' in m) nm.repo = m.repo ? normalizeRepo(m.repo) : '';
    if ('alias' in m) {
      const a = String(m.alias || '').trim();
      need(a.length <= 20 && !/[<>&"\r\n]/.test(a), 'PC 별칭은 20자 이하, 특수기호(<>&")는 쓸 수 없습니다.');
      nm.alias = a;
    }
    if ('enabled' in m) nm.enabled = Boolean(m.enabled) && Boolean(nm.repo);
    next.market = nm;
  }
  writeJson(FILES.config, next);
  return next;
}
