# 구조

외부 패키지 없이 Node.js 표준 라이브러리만 씁니다. 화면(`web/`)은 빌드 없이 그대로 실행되는 순수 JavaScript입니다.

```
bin/ai-office.mjs        명령줄 (serve, open, stop, office, team, doctor)
src/
  server.mjs             127.0.0.1 HTTP 서버: 정적 화면 + JSON API + 자동 복구 타이머
  offices.mjs            사무실 등록부(만들기·불러오기·찾기·해제·경로 복구·옮기기)
  teams.mjs              부서 추가·수정·삭제, 에이전트 파일 생성, CLAUDE.md 조직도 동기화
  presets.mjs            추천 부서
  runner.mjs             사무실 켜기·끄기·재시작 예약, 감시(watchdog)
  updater.mjs            새 버전 감지(GitHub 릴리스)·내려받기·교체·되돌리기·서버 재시작
  claude.mjs             Claude Code 설치·로그인 상태, 공식 로그인 창 열기
  telegram.mjs           토큰 저장, 페어링, 수신 프로세스 진단, 전역 플러그인 끄기
  skills.mjs             SKILL.md·에이전트 머리말 읽기, 스킬트리·변경 이력 수집 (읽기 전용)
  status.mjs             실시간 상태(status.json) 읽기
  hooks/status-hook.mjs  Claude Code 훅: 팀 시작·완료를 status.json 에 기록
templates/office/        새 사무실 견본 (CLAUDE.md, .claude/settings.json, 스킬, 업무데이터)
web/                     대시보드 화면
scripts/                 아이콘, 설치 파일 빌드, 실행기(launch.vbs)
install.ps1              설치 (프로그램은 %LOCALAPPDATA%\AI-Office\app 에 복사)
```

## 사무실이란

사무실 = 폴더 하나. 그 폴더에서 `claude --channels plugin:telegram@claude-plugins-official --permission-mode auto` 를 실행하는 최소화된 콘솔 창이 "출근" 상태입니다.

| 요소 | 위치 | 역할 |
|---|---|---|
| 비서실장 지침 | `CLAUDE.md` | 지시 처리 절차, 보고 서식, 보안 규칙. 조직도 표는 표식(`AI-OFFICE:TEAMS`) 사이가 자동 갱신 |
| 부서 | `.claude/agents/<키>.md` | Claude Code 서브에이전트. 목록의 기준은 `.ai-office/office.json` |
| 스킬 | `.claude/skills/<이름>/SKILL.md` | 머리말 `metadata`(category, created, created-by, request)를 스킬트리가 읽음 |
| 권한·훅 | `.claude/settings.json` | 봇이 쓸 수 있는 명령, 상태 훅. 봇 자신은 이 파일을 고칠 수 없음 |
| 텔레그램 상태 | `.telegram/` | 토큰(`.env`), 허용 목록(`access.json`) |
| 상태 | `.ai-office/state/status.json` | 훅이 기록, 대시보드가 읽음 |

## 부서 관리 흐름

```
대시보드/CLI/봇 ──▶ teams.mjs ──▶ .claude/agents/<키>.md 생성·이동
                              ├─▶ .ai-office/office.json 갱신
                              ├─▶ CLAUDE.md 조직도 표 갱신 (기존 사무실은 처음 한 번 백업)
                              └─▶ 업무데이터/맞춤설정/변경이력.csv 기록
```

Claude Code는 에이전트를 세션 시작 때 읽으므로 변경은 다시 출근한 뒤 적용됩니다. 봇이 `ai-office office restart --delay 60` 을 실행하면 요청 파일(`run/restart-<id>.json`)만 남기고, 대시보드 서버의 감시 타이머가 시간이 되면 끄고 다시 켭니다(봇이 자기 프로세스를 직접 죽이지 않도록).

## 사무실 폐쇄(삭제)

`closeOffice()`는 프로그램의 사무실 위치(`offices\`) 안에 있는 Claude 사무실만 다룹니다. 이름을 똑같이 입력해야 하고, 켜져 있으면 먼저 끕니다.
폴더(봇 토큰·업무 기록 포함)는 지우지 않고 `<데이터>\closed\<id>_<시각>`으로 **옮긴 뒤에만** 등록을 지웁니다. 되살리려면 「기존 폴더 불러오기」로 그 폴더를 등록합니다.
직접 불러온 폴더(바탕화면 등)와 읽기 전용 봇은 폐쇄할 수 없고, 파일을 그대로 두는 「등록 해제」만 됩니다.

## 프로그램 업데이트

대시보드 서버가 시작 30초 뒤와 6시간마다 `releases/latest`를 조회해 새 버전을 감지하고, 화면 위쪽에 알림을 띄웁니다. 설치는 **사용자가 「지금 업데이트」를 눌렀을 때만** 합니다
(설정의 「자동 설치」를 켠 경우에는 감지 즉시 설치. 기본은 꺼짐).

```
릴리스 zip(ai-office-app.zip) 내려받기 ─▶ sha256 검증(릴리스가 알려 준 값) ─▶ 압축 풀기
  ─▶ 점검(name=ai-office, 버전 상승, 필수 파일, node --check) ─▶ 현재 app\ 백업(최근 3개 유지)
  ─▶ bin·src·web·templates·scripts·assets 를 새 파일로 맞춤 ─▶ install.json 버전 갱신 ─▶ 서버 다시 시작
```

- 주소는 `github.com/po3561/ai-office/releases/download/`로 고정이고, 그 밖의 주소는 받지 않습니다. 실패하면 교체하지 않거나 백업으로 되돌립니다.
- 설치된 프로그램(`<설치폴더>\app`)만 교체합니다. 소스 폴더에서 직접 실행 중이면 알림만 띄우고 `git pull`을 안내합니다.
- 사무실(봇)과 데이터는 건드리지 않으며, 업데이트 중에도 사무실은 계속 근무합니다. 서버 시작 때 `repairOffices()`가 사무실 설정을 새 버전에 맞춥니다.
- 새 버전을 내보내려면 `package.json`의 `version`을 올리고 `v0.x.y` 태그를 올립니다(`release.yml`이 zip 을 만들어 릴리스에 붙입니다).

## 경로가 바뀌어도 계속 도는 이유

- 프로그램은 고정 위치(`%LOCALAPPDATA%\AI-Office\app`), 사무실 데이터는 `…\offices\`에 둡니다. 바탕화면·다운로드 폴더와 무관합니다.
- 사무실의 훅·허용 명령은 프로그램 위치를 절대 경로로 가리킵니다. 대시보드 서버는 시작할 때마다 `repairOffices()`로 이를 현재 설치 위치에 맞춰 다시 씁니다(재설치·이동 후에도 복구).
- 자동 시작은 작업 스케줄러(`AI-Office Dashboard`, 로그인 시)가 `launch.vbs`를 절대 경로로 실행합니다.

## 읽기 전용 봇(Hermes)

`offices.json`에서 `kind: "hermes"` 인 항목은 `mutable()` 검사에서 항상 403이 되며, 시작·중지·재시작·부서·토큰 API가 모두 이를 거칩니다. 상태는 `gateway_state.json`, 스킬은 `skills/`를 읽기만 합니다.

## 보안 경계

`SECURITY.md` 참고. 테스트(`test/server.test.mjs`)가 Origin·Host·경로 이탈 방어를, `test/offices.test.mjs`가 읽기 전용 보장을 확인합니다.
