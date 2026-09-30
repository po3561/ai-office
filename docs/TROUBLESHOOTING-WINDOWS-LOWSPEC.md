# 저사양·두 번째 Windows PC에서 설치할 때 만난 문제 정리

메인 PC와 별도로 **서브 PC**(Ryzen 3급 노트북, C 드라이브 여유 약 12GB)에 AI-Office 0.1.3을 새로 설치하고
출근 → 텔레그램 응답까지 연결하면서 겪은 문제와 해결을 시간 순서로 정리합니다.
같은 증상이 나오면 위에서부터 확인하세요. (사용자 이름·봇 이름·토큰 등 개인정보는 일부러 뺐습니다.)

## 한눈에 보기

| # | 증상 | 원인 | 해결 |
|---|---|---|---|
| 1 | PowerShell에서 `claude`가 "스크립트를 실행할 수 없다"며 막힘 | 실행 정책이 `claude.ps1`을 차단 | `claude.cmd`를 쓰거나 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| 2 | 대시보드의 로그인 버튼을 눌러도 로그인이 끝나지 않음 | 새 창에서 브라우저 승인 뒤 **코드 붙여넣기**가 필요한데 창을 놓치거나 닫음 | 일반 터미널에서 `claude auth login --claudeai` 실행 후 코드를 붙여넣기 |
| 3 | 로그인 창에서 Enter가 안 먹음 | 콘솔이 **텍스트 선택 모드**로 멈춤(창 제목 앞에 "선택") | `Esc`로 선택 모드 해제 후 Enter |
| 4 | 출근하자마자 세션이 종료됨 | 이 PC에는 **텔레그램 플러그인이 설치돼 있지 않음** | 공식 마켓플레이스에서 설치 (아래 4번) |
| 5 | 플러그인 설치 후 다른 Claude 창이 봇 수신을 가로챌 위험 | 설치 범위가 `user`(전역)로 켜짐 | 전역은 끄고 사무실 폴더 설정으로만 켬 |
| 6 | 대시보드 「출근」 API는 `started: true`인데 창이 뜨지 않음 | 서버가 `stdio: 'ignore'`로 하위 프로세스를 띄우면 최소화 창이 안 생기는 환경이 있음 | `src/runner.mjs` 수정(이 브랜치) |
| 7 | 출근은 됐는데 텔레그램에서 응답이 없음 (폴더 신뢰 질문) | 사무실 폴더 **신뢰 질문**에서 멈춰 있음 | 최소화된 사무실 창에서 「Yes, I trust this folder」 |
| 8 | 텔레그램 서버에 미처리 메시지가 쌓임 (`pending_update_count` 증가) | 플러그인이 30초 안에 응답하지 못해 `CONNECT_TIMEOUT` | `MCP_TIMEOUT` 상향(이 브랜치) |
| 9 | 사무실 세션이 2~3개 동시에 뜸 | 수동 출근과 감시(자동 출근)가 거의 동시에 실행 | `startOffice`/감시에 "방금 켠 사무실" 보호 추가(이 브랜치) |
| 10 | 세션은 떠 있는데 `/mcp`에서 텔레그램이 ✗ failed | 시작 시 연결 실패 상태로 굳음 | `/mcp` → `plugin:telegram:telegram` → **Reconnect** |
| 11 | 프로그램·데이터를 다른 드라이브로 옮기면 지침의 명령 경로만 옛 위치로 남음 | `repairOffices()`가 설정 파일만 고치고 `CLAUDE.md`·스킬 문서는 안 고침 | 문서의 `ai-office.mjs` 경로도 보정(이 브랜치) |
| 12 | 폴더를 정션으로 옮겼더니 자동 시작·토큰 인식이 안 됨 | 작업 스케줄러로 뜬 프로세스가 정션 경로를 따라가지 못함 | 정션에 기대지 말고 **실제 경로**로 등록 (아래 11번) |

## 1. `claude.ps1` 실행 정책 오류

```
claude : 이 시스템에서 스크립트를 실행할 수 없으므로 ...\npm\claude.ps1 파일을 로드할 수 없습니다.
```

`npm -g`로 설치한 `claude`는 `claude.ps1` 래퍼를 통해 실행되는데, 기본 실행 정책(Restricted)이 막습니다.
관리자 권한이 필요 없는 방법 두 가지:

```powershell
claude.cmd auth login --claudeai                               # 1) .cmd로 우회
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned   # 2) 현재 사용자만 허용
```

> 대시보드가 만드는 실행 스크립트는 `-ExecutionPolicy Bypass`와 `claude.exe` 직접 호출을 쓰므로 이 문제와 무관합니다.

## 2~3. 로그인이 안 끝날 때

`claude auth login --claudeai`는 브라우저 인증 뒤 **코드를 터미널에 붙여넣는** 단계에서 대기합니다.

1. 터미널에서 실행하고 브라우저에서 계정을 승인합니다.
2. 화면에 나온 코드를 `Paste code here if prompted >` 뒤에 붙여넣습니다(우클릭 또는 `Ctrl+V`).
3. `claude auth status`가 `"loggedIn": true`이면 성공입니다.
4. 이후 `Login successful. Press Enter to continue…`에서 Enter가 안 먹으면 창 제목이 `선택 …`으로 시작하는지 보세요.
   콘솔이 텍스트 선택 모드에 들어가면 입력이 멈춥니다. **Esc**로 풀면 됩니다.

같은 계정으로 두 PC를 쓰는 것은 문제없습니다(로그인 정보는 PC별 저장). 다만 사용량 한도는 계정 단위로 공유됩니다.

## 4~5. 텔레그램 플러그인 설치

증상: `claude plugin list`가 `No plugins installed`, 출근 직후 세션이 종료됨.

```powershell
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install telegram@claude-plugins-official
claude plugin disable telegram@claude-plugins-official --scope user   # 전역은 끄기
```

마지막 줄이 중요합니다. 전역으로 켜 두면 새 Claude 창마다 봇 수신을 가로챕니다
([TELEGRAM.md](TELEGRAM.md) 참고). 사무실 폴더의 `.claude/settings.json`이 이 플러그인을 따로 켜 둡니다.

## 6. 출근이 조용히 실패 (`stdio: 'ignore'`)

`POST /api/offices/:id/start`가 `{"started":true,"via":"launcher"}`를 돌려주지만 사무실 창이 뜨지 않고
`run/office.pid`도 생기지 않았습니다. 같은 명령을 셸에서 직접 실행하면 정상이었습니다.

원인 분리 결과(같은 `Start-Process` 명령, 옵션만 바꿔 실험):

| 옵션 | 결과 |
|---|---|
| `stdio: 'ignore'` (`detached` 여부·`windowsHide` 여부 무관) | **창이 안 뜸** |
| `stdio: 'ignore'` 대신 NUL 장치 핸들 | 창이 안 뜸 |
| `stdio: ['pipe','pipe','pipe']` | 정상 |

그래서 `startOffice()`가 `spawn(..., { stdio: 'ignore' })` 대신 기존 유틸 `run()`(파이프 방식)을 쓰도록 바꿨습니다.
중간 PowerShell은 `Start-Process` 직후 바로 끝나므로 대기 시간이 길지 않습니다.
(예전 방식 `o.launch.start` 경로는 건드리지 않았습니다.)

## 7. 폴더 신뢰 질문

처음 한 번은 사무실 창(작업 표시줄에 최소화)에서 **"Yes, I trust this folder"** 를 골라야 합니다.
기본 선택이 `No, exit`라서 Enter만 누르면 세션이 종료되고, 감시가 새 세션을 다시 띄워 같은 질문이 또 나옵니다.
↓ 키로 `Yes`를 고른 뒤 Enter를 누르세요.

## 8. `CONNECT_TIMEOUT` — 플러그인 시작이 30초를 넘김

Claude Code의 MCP 로그(`%LOCALAPPDATA%\claude-cli-nodejs\Cache\<프로젝트>\mcp-logs-plugin-telegram-telegram\*.jsonl`):

```
Connection failed after 29109ms (CONNECT_TIMEOUT): Request timed out
```

텔레그램 플러그인의 시작 스크립트는 매번 `bun install --no-summary && bun server.ts`를 실행합니다.
저사양 PC에서는 MCP 핸드셰이크 응답까지 약 36초가 걸려 기본 한도 30초를 넘겼습니다.
출근 스크립트(`run\office.ps1`)에 `MCP_TIMEOUT`을 추가해 대기 한도를 180초로 늘렸습니다.

```powershell
$env:MCP_TIMEOUT = '180000'
```

증상 확인 방법(봇 토큰은 출력하지 않는 조회):
`getWebhookInfo`의 `pending_update_count`가 0이 아니면, 메시지는 텔레그램 서버에 쌓였는데 받는 프로세스가 없다는 뜻입니다.
메인 PC가 가로챈 경우에는 이 값이 계속 0으로 유지됩니다.

## 9. 세션 중복

서버 재시작 직후 수동 「출근」과 감시(`watchdogTick`의 자동 출근)가 겹치면 사무실 세션이 2~3개 뜹니다.
서로 봇 수신을 놓고 다투므로 **하나만 남겨야** 합니다. 관리 중인 세션은 `run\office.pid`의 PowerShell이 부모인 세션입니다.

원인은 `pid` 파일이 창이 뜬 뒤 수십 초가 지나서야 생기기 때문입니다. 그 사이에는 `runtime()`이 "꺼짐"으로 보여
수동 출근과 감시가 각각 새 세션을 띄웠습니다.

수정: `runner.mjs`에 사무실별 "방금 켬" 기록(90초)을 두고, 그 시간 안에는 `startOffice()`가 409로 거절하고
`watchdogTick()`도 자동 출근을 건너뜁니다. 「끄기」는 기록을 지웁니다. (서버 한 프로세스 안에서 일어나는 경합이라 메모리 기록으로 충분합니다.)

## 10. 세션이 떠 있는데 텔레그램이 안 붙을 때

`/mcp`에서 `plugin:telegram:telegram`이 ✗ failed이면 해당 항목에서 **Reconnect**를 고르세요.
재연결 로그에는 `Successfully connected` → `Channel notifications registered` 순으로 나오고, 쌓인 메시지가 바로 전달됩니다.

> 원인은 아직 확정하지 못했습니다. 세션 시작 시점에 플러그인 로딩이 느려 채널 등록 시도가 먼저 실패하는
> 시작 순서 문제로 추정하지만 확인된 사실은 아닙니다. 이 브랜치의 수정 후 재부팅 상태에서의 안정성은 더 지켜봐야 합니다.

## 11. 프로그램·데이터를 C에서 D 드라이브로 옮기기

C 드라이브 여유가 적을 때 `%LOCALAPPDATA%\AI-Office` 전체를 옮기는 방법과, 겪은 함정입니다.

1. 사무실을 끄고(`stop`) 서버를 끕니다(`ai-office stop`). 열려 있는 탐색기 창도 그 폴더에서 벗어나야 이름 변경이 됩니다.
2. `robocopy "%LOCALAPPDATA%\AI-Office" "D:\AI-Office" /E /COPY:DAT`로 복사하고 파일 수·용량이 같은지 확인합니다.
3. 프로그램은 자기 옆 폴더를 데이터 폴더로 쓰므로(`install.json`이 있는 위치), `D:\AI-Office\app`에서 실행하면 데이터도 자동으로 D를 씁니다.
4. **정션(`mklink /J`)만 걸어 두면 안 됩니다.** 대화형 셸에서는 잘 되지만, 작업 스케줄러로 뜬 `wscript`/`node`는 정션 경로의
   `launch.vbs`와 토큰 파일을 찾지 못했습니다(“스크립트 파일을 찾을 수 없습니다”, “봇 토큰이 아직 없습니다”).
   그래서 아래를 **실제 D 경로**로 바꿔야 합니다.
   - 작업 스케줄러 `AI-Office Dashboard`의 동작 인수(`launch.vbs`, `ai-office.mjs` 경로)
   - `offices.json`의 `folder`, `stateDir`
   - 바탕화면·시작 메뉴 바로가기, `install.json`의 `app`
5. 사무실 폴더의 경로가 바뀌면 Claude Code는 새 폴더로 보고 **신뢰 질문을 다시** 합니다(7번).
6. `CLAUDE.md`·스킬 문서 속 명령 경로는 이 브랜치의 `repairOffices()`가 자동으로 고칩니다(문서 보정 추가 전에는 손으로 바꿔야 했음).
7. 원본 C 폴더는 확인이 끝날 때까지 이름을 바꿔 백업으로 둡니다.

Claude Code 자체 데이터(`%USERPROFILE%\.claude`: 플러그인 캐시·대화 기록)는 이 방법으로는 옮겨지지 않습니다.

## 보안 참고: 사무실 세션이 계정의 커넥터를 상속함

`/mcp` 화면에 Gmail·Google Drive·Google Calendar·Notion 같은 claude.ai 커넥터가 그대로 연결돼 있었습니다.
사무실은 텔레그램 지시를 받아 일하므로, 이 커넥터들도 지시로 쓸 수 있는 상태입니다.
사무실에 필요 없는 커넥터는 claude.ai 설정에서 끄거나 사무실 세션에서 비활성화하는 것을 권장합니다.

## 그 밖의 서브 PC 운영 팁

- **봇 토큰은 PC마다 따로.** 같은 토큰은 한 곳에서만 수신할 수 있습니다. 서브 PC용 봇을 BotFather에서 새로 만드세요.
- **절전 끄기.** 노트북이 잠들면 봇이 멈춥니다: `powercfg /change standby-timeout-ac 0`
- **디스크.** 사무실 산출물은 `%LOCALAPPDATA%\AI-Office\offices\`에 쌓입니다. C 드라이브 여유가 적으면 주기적으로 정리하세요.
- **사무실 이름 구분.** 대시보드에서 이름에 "(서브PC)"처럼 표시해 두면 헷갈리지 않습니다.
