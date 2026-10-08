// 이 프로그램이 쓰는 위치. 바탕화면이나 프로젝트 폴더가 바뀌어도 영향을 받지 않도록
// 프로그램 파일(APP_HOME)과 데이터(DATA_HOME)를 고정 위치에 둔다.
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(APP_HOME, 'bin', 'ai-office.mjs');
export const STATUS_HOOK = join(APP_HOME, 'src', 'hooks', 'status-hook.mjs');
export const TEMPLATES = join(APP_HOME, 'templates');
export const WEB = join(APP_HOME, 'web');

const localApp = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
// 설치된 프로그램(<설치폴더>\app)은 자기 옆(<설치폴더>)을 데이터 폴더로 쓴다. 소스에서 바로 실행하면 기본 위치를 쓴다.
const installedRoot = resolve(APP_HOME, '..');
export const DATA_HOME = process.env.AI_OFFICE_HOME
  || (existsSync(join(installedRoot, 'install.json')) ? installedRoot : null)
  || (process.platform === 'win32' ? join(localApp, 'AI-Office') : join(homedir(), '.local', 'share', 'ai-office'));
export const OFFICES_DIR = join(DATA_HOME, 'offices');
export const RUN_DIR = join(DATA_HOME, 'run');
export const LOG_DIR = join(DATA_HOME, 'logs');
export const CLOSED_DIR = join(DATA_HOME, 'closed');   // 폐쇄한 사무실 폴더를 지우지 않고 옮겨 두는 곳
export const UPDATE_DIR = join(DATA_HOME, 'update');   // 업데이트 내려받기·백업
export const TOOLS_DIR = join(DATA_HOME, 'tools');     // 앱이 내려받아 둔 도구(Bun·Codex 등)
export const BOTS_DIR = join(DATA_HOME, 'bots');       // LAPIS 런타임 봇(bot.json 한 폴더씩)
export const MARKET_DIR = join(DATA_HOME, 'market');   // 스킬 마켓: 저장소 복제본(cache)과 설치 기록
export const CONNECTORS_DIR = join(DATA_HOME, 'connectors');   // 커넥터: 봇마다 대시보드 호출 키(.token), Hermes 설정 백업
export const FILES = {
  config: join(DATA_HOME, 'config.json'),
  offices: join(DATA_HOME, 'offices.json'),
  install: join(DATA_HOME, 'install.json'),
  connectors: join(DATA_HOME, 'connectors.json'),   // 봇별 커넥터 설정(대시보드가 호출 키 확인에 읽는다)
};

export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const CLAUDE_USER_SETTINGS = join(CLAUDE_HOME, 'settings.json');
export const DEFAULT_TG_STATE = join(CLAUDE_HOME, 'channels', 'telegram');
export const SHARED_SKILLS = join(CLAUDE_HOME, 'skills');
export const TG_PLUGIN = 'telegram@claude-plugins-official';
