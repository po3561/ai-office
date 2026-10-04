// 앱이 내려받은 도구와 공식 설치 위치를 PATH 앞에 붙이기 위한 목록.
// 새로 설치한 도구도 앱이 띄우는 프로세스(사무실 등)가 바로 찾을 수 있게 한다.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TOOLS_DIR } from './paths.mjs';
import { isDir } from './util.mjs';

export function toolDirs(toolsDir = TOOLS_DIR) {
  const localApp = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return [
    join(toolsDir, 'bun'), join(toolsDir, 'codex'), join(homedir(), '.local', 'bin'), join(homedir(), '.bun', 'bin'),
    join(localApp, 'Programs', 'Ollama'), join(localApp, 'hermes', 'hermes-agent', 'venv', 'Scripts'), join(localApp, 'hermes', 'bin'),
  ].filter(isDir);
}
