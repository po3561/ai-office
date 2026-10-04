# LAPIS 플랫폼 설계 (설치형 앱 · 연결 허브 · 봇 스튜디오 · 웹 배포 · 랜딩)

작성일 2026-10-04. 사용자 승인을 받은 설계이며 단계별로 구현·테스트·커밋한다.

## 목표
일반인이 터미널 없이 설치 파일 하나로 시작해, 앱 안에서 봇 생성·Claude/GPT/Google/텔레그램 연결·
Ollama/Hermes/Claude Office 설치를 끝내고, 봇을 1개든 여러 개든 만들어 주제방·에이전트별로 설정하며,
로컬 봇을 Cloudflare Workers 웹 주소로 배포할 수 있게 한다.

## 구조
```
LAPIS-Setup.exe (≈1MB, C# WinForms, csc 로 빌드)
  └ 앱 zip(GitHub 릴리스) + 휴대용 Node(nodejs.org, SHASUMS 검증) 내려받기 → %LOCALAPPDATA%\AI-Office
LAPIS.exe (트레이 호스트) → 엔진(:5000) + 대시보드(:4310) 를 창 없이 켜고 앱 창(Edge --app)을 연다
엔진(src/)          컴포넌트 관리자, 연결 허브, 런타임, 배포기 — 새 API 는 /api/... 로 노출
대시보드(dashboard/) 시작 마법사 · 연결 허브 · 봇 스튜디오 · 웹 배포 화면 (office-routes.json 허용 목록으로 엔진 호출)
ciel-worker-api     / 랜딩, /app 업무 공간
```

## 1. 컴포넌트 관리자 (`src/components.mjs`)
컴포넌트: node(감지만), bun, claude, codex, ollama, hermes. 각각 `detect()`(설치 여부·버전·경로)와
`install(job)`(사용자가 누를 때만, 허용된 공식 주소에서만 내려받기, 진행률 기록)을 가진다.
작업(job)은 메모리에 기록(`GET /api/jobs/:id`)하고 화면이 폴링한다. 도구 폴더는 `<DATA>\tools`.
설치된 항목은 건너뛴다. 실패하면 이유와 로그를 남긴다.

## 2. 연결 허브
Claude(기존), GPT(Codex 설치 + ChatGPT 로그인 창, OpenAI API 키는 DPAPI 보관), Google(라피스 OAuth),
텔레그램(BotFather 안내 → 토큰 검증·연결). 한 화면에서 상태·연결·해제.

## 3. 봇·에이전트 스튜디오
봇 1개 빠른 시작 / N개 확장. 엔진은 봇·에이전트별 선택: Claude Office(기존), Hermes(프로필·게이트웨이),
LAPIS 런타임(Ollama · OpenAI API · ChatGPT(Codex)). 설정 3단계: 봇 → 주제방 → 에이전트(엔진·모델·지침·스킬·권한).
런타임 봇은 텔레그램 롱폴링으로 동작하며 에이전트 명세(JSON)로 정의한다. 스킬 마켓은 기존 기능 + 에이전트에 스킬 붙이기.

## 4. 웹 배포 (Cloudflare Workers)
런타임 봇 하나의 명세를 Worker 코드로 생성(웹 채팅, 텔레그램 웹훅, 암호 보호)하고 사용자의 Cloudflare 계정에
wrangler 로 배포해 `*.workers.dev` 주소를 돌려준다. Worker 는 PC 파일·Claude Code 구독을 쓸 수 없으므로
API 키 엔진(OpenAI, Claude API, Workers AI)만 지원하며 화면이 이를 안내한다. 비밀 값은 `wrangler secret` 으로만 올린다.

## 5. 랜딩페이지
`ciel-worker-api` 의 `/` 를 소개 페이지로 교체하고 기존 업무 공간은 `/app` 에 둔다. 운영 배포는 로컬 확인 후 사용자 승인을 받아 진행한다.

## 보안 원칙
- 내려받기 주소는 코드에 고정한 공식 호스트만, 해시가 제공되면 검증한다.
- 설치·로그인·배포는 모두 사용자가 버튼을 눌렀을 때만 실행한다.
- 비밀(API 키, 토큰)은 화면·로그에 내보내지 않고 DPAPI 로 암호화한다.

## 검증
컴포넌트 설치 로직은 가짜 서버와 임시 폴더로 자동 테스트한다. 이 PC 의 실제 도구는 감지만 검증한다.
깨끗한 PC 에서의 전체 설치는 직접 검증할 수 없으므로 설치 로그와 점검 항목으로 보완한다.
