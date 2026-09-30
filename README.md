# AI-Office

**텔레그램으로 지시하는 나만의 AI 사무실.** 본인의 [Claude Code](https://claude.com/claude-code) 계정만 있으면, 비서실장 봇과 여러 부서(에이전트)를 꾸려 업무를 맡기고, 결과를 텔레그램으로 받아 볼 수 있습니다.

> 휴대폰에서 "행사 기획안 만들어줘" → 비서실장이 접수 → 기획팀·리서치팀·검수팀이 나눠 작업 → 결과 파일이 텔레그램으로 도착.
> PC의 대시보드에서는 누가 지금 무슨 일을 하는지 실시간으로 보이고, 부서를 늘리고 줄일 수 있습니다.

## 주요 기능

| | |
|---|---|
| 🏢 **여러 사무실(봇)** | 봇 하나 = 분리된 환경 폴더 하나. 사무실마다 텔레그램 봇·부서·스킬이 따로 있고 서로 영향을 주지 않습니다. |
| 👥 **부서 편성** | 추천 부서(기획·리서치·홍보·개발·검수·인사·재무·법무·디자인 …)에서 고르거나 직접 만들고, 언제든 없앨 수 있습니다. 텔레그램에서 "인사팀 추가해줘"라고 말해도 됩니다. |
| 🔑 **Claude 로그인** | 대시보드에서 Claude Code 설치·로그인 상태를 확인하고 공식 로그인 창을 엽니다. 비밀번호·토큰은 이 프로그램이 받거나 저장하지 않습니다. |
| 🧩 **스킬트리** | "앞으로 ○○할 때는 이렇게 해"라고 하면 봇이 스스로 스킬을 만들고, 대시보드의 스킬트리에 "📱 텔레그램 지시로 생성"으로 나타납니다. |
| 📡 **수신 진단** | 텔레그램 수신을 가로채는 프로세스를 찾아 정리합니다(아래 "문제 해결" 참고). |
| 🔒 **읽기 전용 인식** | Hermes(라피스 등) 같은 별개의 봇은 인식만 하고 켜거나 끄거나 바꾸지 않습니다. |
| 📌 **고정 설치** | 바탕화면을 정리하거나 폴더를 옮겨도 계속 돌아가도록 고정 위치에 설치되고, 경로가 바뀌면 사무실 설정을 스스로 다시 맞춥니다. |

## 필요한 것

- Windows 10/11
- 본인의 **Claude 계정**(Pro·Max·Team 등) — 사무실이 그 계정의 사용량으로 일합니다
- [Node.js](https://nodejs.org) 20 이상, [Bun](https://bun.sh) (텔레그램 플러그인 실행용) — 설치 프로그램이 `winget`으로 설치를 도와줍니다
- 텔레그램 계정과, [@BotFather](https://t.me/BotFather)에서 만든 봇 토큰

## 설치

**설치 파일(권장)** — [Releases](../../releases/latest)에서 `AI-Office-Setup.exe`를 받아 실행합니다.
(서명되지 않은 파일이라 Windows SmartScreen 경고가 나올 수 있습니다. 「추가 정보 → 실행」을 누르세요.)

**소스에서 설치**

```powershell
git clone https://github.com/<OWNER>/ai-office.git
cd ai-office
powershell -ExecutionPolicy Bypass -File install.ps1
```

설치 위치는 `%LOCALAPPDATA%\AI-Office` 입니다(프로그램은 `app\`, 설정·사무실은 그 아래). 시작 메뉴와 바탕화면에 「AI-Office 대시보드」 바로가기가 생기고, 로그인할 때 대시보드 서버가 자동으로 시작됩니다.

## 처음 시작하기 (약 5분)

대시보드 「홈」의 **시작하기** 체크리스트를 순서대로 따라가면 됩니다.

1. **Claude 계정 연결** — 「연결 · 계정」에서 로그인(브라우저 인증).
2. **텔레그램 봇 연결** — BotFather에게 `/newbot`을 보내 봇을 만들고, 받은 토큰을 붙여 넣습니다.
3. **출근** — 사무실을 출근시킵니다. 처음 한 번은 작업 표시줄의 `AI-Office · 사무실이름` 창에서 폴더 신뢰 질문에 Enter(Yes)를 누릅니다.
4. **내 계정 허용** — 텔레그램에서 봇에게 아무 메시지나 보내 6자리 코드를 받고, 대시보드에 입력합니다.

이제 텔레그램에서 지시하세요.

```
현황
행사 10월 25일 가을 축제 기획안 만들어줘. 예산 500만원
인사팀 추가해줘                    ← 부서를 늘립니다 (재시작 후 적용)
앞으로 보고서는 항상 개조식으로 써   ← 봇이 스스로 규칙/스킬을 만듭니다
퇴근
```

## 부서(에이전트)는 이렇게 동작합니다

부서 하나는 사무실 폴더의 `.claude/agents/<키>.md` (Claude Code 서브에이전트)입니다. 비서실장(메인 세션)이 지시를 받아 맞는 부서를 호출하고, 결과를 모아 텔레그램으로 보고합니다.

- 대시보드 **부서 관리**나 명령줄(`ai-office team …`)로 추가·수정·삭제합니다. 봇도 같은 명령으로 부서를 관리합니다.
- 삭제해도 파일은 지우지 않고 `보관함/부서보관/`으로 옮깁니다. 모든 변경은 `업무데이터/맞춤설정/변경이력.csv`에 기록됩니다.
- 사무실의 `CLAUDE.md`(비서실장 지침) 속 조직도 표는 자동으로 갱신됩니다.
- 부서 변경은 사무실을 **다시 출근**시킨 뒤부터 적용됩니다(Claude Code는 시작할 때 에이전트를 읽습니다).

```powershell
ai-office team presets                                   # 추천 부서 목록
ai-office team add --office my-office --preset hr        # 추천 부서 추가
ai-office team add --office my-office --name "물류팀" --role "배송 일정과 재고 관리"
ai-office team remove --office my-office --key hr
```

## 폴더 구조

```
%LOCALAPPDATA%\AI-Office\
├─ app\                     프로그램 (업그레이드하면 덮어씀)
├─ config.json              설정
├─ offices.json             등록된 사무실 목록
└─ offices\<사무실>\         사무실 하나 = 분리된 환경
   ├─ CLAUDE.md             비서실장 지침
   ├─ .claude\agents\       부서들
   ├─ .claude\skills\       스킬들 (텔레그램 지시로 생긴 것 포함)
   ├─ .telegram\            이 사무실 봇의 토큰·접근 허용 목록
   ├─ 결과물\  업무일지\  업무데이터\  보관함\
   └─ .ai-office\           대시보드가 관리하는 내부 상태
```

## 문제 해결

**텔레그램으로 지시했는데 봇이 읽고 반응이 없어요**
텔레그램 봇 토큰 하나는 **한 곳에서만** 메시지를 받을 수 있습니다. Claude Code의 텔레그램 플러그인이 `settings.json`에서 전역으로 켜져 있으면, 새 Claude 창을 열 때마다 그 창이 수신권을 가로채 메시지가 사무실에 도착하지 않습니다.
대시보드 「연결 · 계정 → 수신 진단」에서 확인하고 **가로채는 프로세스 정리**와 **전역에서 끄기**를 누르세요. 사무실 폴더는 설정으로 따로 플러그인을 켜 두므로 사무실은 영향받지 않습니다. 자세한 설명은 [docs/TELEGRAM.md](docs/TELEGRAM.md).

**출근을 눌렀는데 아무 일도 없어요** — 「연결 · 계정」에서 Claude 로그인, 봇 토큰이 모두 준비됐는지, `bun`이 설치돼 있는지 확인하세요. `ai-office doctor`로 한 번에 점검할 수 있습니다.

## 보안 원칙

- 대시보드는 `127.0.0.1`(이 PC)에서만 열리고, 변경 요청은 대시보드 화면이 보낸 것만 받습니다(Host·Origin·헤더 확인).
- 봇 토큰은 사무실 폴더의 `.telegram/.env`에만 저장되며 화면·로그·API에 노출되지 않습니다. 봇은 자기 토큰 폴더와 권한 설정을 읽거나 고칠 수 없게 막혀 있습니다.
- 텔레그램 접근 허용(페어링)은 대시보드나 터미널에서만 바뀌고, 텔레그램 메시지로는 바뀌지 않습니다.
- 파일은 지우지 않고 `보관함/`으로 옮깁니다. 외부 발송·게시·결제는 사용자의 명시적 승인 뒤에만 합니다.
- 자세한 내용은 [SECURITY.md](SECURITY.md).

## 개발

```powershell
npm test                     # 자동 테스트 (Node 20+, 추가 패키지 없음)
node bin/ai-office.mjs serve # 대시보드 서버 실행 (http://127.0.0.1:3300)
npm run build:installer      # dist\AI-Office-Setup.exe 만들기 (Windows, IExpress 사용)
npm run privacy-check        # 공개 전에 개인정보·토큰이 섞이지 않았는지 검사
```

구조 설명은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), 현재 범위와 예정 기능은 아래를 보세요.

## 현재 범위와 로드맵

- ✅ 사무실·부서 관리, 실시간 현황판, 스킬트리, Claude 로그인, 텔레그램 토큰·페어링, 수신 진단, 설치 파일
- 🔜 텔레그램 그룹방·주제(토픽)별 담당 부서 지정, 정기 보고(아침 업무보고·저녁 결산) 설정 화면
- 🔜 macOS/Linux 지원 (사무실 실행 부분이 현재 Windows 전용)

## 제거

시작 메뉴의 AI-Office 폴더 또는 `powershell -ExecutionPolicy Bypass -File uninstall.ps1` (사무실 데이터는 남기며, `-PurgeData`를 주면 모두 지웁니다).

## English summary

AI-Office turns your own Claude Code account into a small "office" you command from Telegram: a chief-of-staff bot plus configurable departments (Claude Code subagents). A local dashboard (127.0.0.1) shows live status, lets you add/remove departments, sign in to Claude, connect a Telegram bot, and diagnose Telegram polling conflicts. Each bot lives in its own isolated environment folder; other bots (e.g. Hermes) are recognized read-only. Windows-first; requires Node 20+, Bun, and a Claude account. MIT licensed.

## 라이선스

[MIT](LICENSE)
