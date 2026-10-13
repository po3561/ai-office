# LAPIS 그룹웨어 계획 (메신저 · 메일 연동 · 유료 잠금)

작성 2026-10-13 · 개정 2판(사용자 결정 반영). 계획 단계 문서다. 사용자가 「진행」이라고 하면 0단계부터 구현·테스트·커밋한다.

## 0. 확정된 결정 (2026-10-13)

| 항목 | 결정 |
|---|---|
| 화면 위치 | **LAPIS 에디터(editor-office)**. 웹 `/app` 은 에디터를 배포할 때 같은 화면이 자동으로 올라간다. |
| 진행 순서 | 0단계(잠금 + 회사·조직도)를 먼저 깐다. 그 위에서 **메신저(A)와 메일(B)을 함께** 진행한다. |
| 유료 잠금 | 처음부터 모든 기능에 넣는다. 전역 스위치 `LAPIS_PAYWALL=off` 로 **지금은 모두 연다.** |
| 기준 제품 | 다우오피스. 네이버웍스·카카오워크·Teams·Slack 의 기업 기능을 LAPIS 에 맞게 바꿔 넣는다. |

## 1. 목표와 차별점

- 회사 업무 연락을 LAPIS 하나로 끝낸다. 범위는 메신저, 메일, 조직도이고, 이어서 게시판·결재·근태를 붙인다.
- 차별점은 **AI 봇이 동료처럼 일하는 그룹웨어**다.
  - 대화방에서 `@봇` 을 부르면 회의를 요약하고 할 일을 만든다.
  - 메일을 요약하고 답장 초안을 쓴다.
  - 메일을 할 일·일정으로 바꾼다.
  - 「오늘」 화면에 중요한 메일과 메시지 브리핑을 띄운다.
- 메일 서버는 새로 만들지 않는다. **이미 쓰는 메일을 연결**한다. 운영 부담과 스팸·전송 신뢰도 문제를 피하기 위해서다.

## 2. 참고 제품에서 가져올 것

| 영역 | 다우오피스 | 대기업 사례 | LAPIS 반영 |
|---|---|---|---|
| 메신저 | 사내 메신저·쪽지, 조직도에서 바로 대화 | 채널·스레드, 멘션, 읽음 숫자, 회수, 외부 게스트 | 1:1·그룹·부서방·공지방, 안 읽은 사람 숫자, 수정·회수, 답글, 반응, 공지 고정, 멘션, 파일, **봇 참여** |
| 메일 | 자체 메일, 결재·게시판 연동 | 통합 받은편지함, 예약 발송, 메일을 대화로 공유 | IMAP/SMTP·Outlook 연결, 통합 받은편지함, 메신저 공유, AI 요약·할 일 변환 |
| 조직 | 조직도·주소록·직급/직책 | 겸직, 상태(회의 중·휴가), 프로필 카드 | 회사·부서 트리·직급·직책·상태·프로필 카드 |
| 확장 | 전자결재, 게시판, 캘린더, 근태, 자원 예약, 설문, 문서함 | 감사 로그, 보존 정책, DLP, SSO | 3~4단계 |

## 3. 구조

```
[화면] editor-office 렌더러 (웹 /app 도 같은 바이트)
   새 페이지: 메신저 · 메일 · 조직도 (+ 「오늘」 카드, 관리자 「요금제」 탭)
   ├─ 클라우드 호출: 기존 lapisRequest (본체 ipc `lapis:request` / 웹 web-bridge)
   ├─ 실시간: 렌더러 CSP 가 connect-src 'none' 이므로
   │     에디터 → 본체(main)가 WebSocket 을 잡고 ipc 이벤트 `gw:event` 로 전달
   │     웹    → web-bridge 가 같은 출처 wss 로 직접 연결
   └─ 메일: 4310 런타임 경유 (에디터 = local-bridge, 웹 = web-access 같은 계정 규칙)

[클라우드] ciel-worker-api (D1 · R2 USER_MEDIA · Durable Objects, 모두 이미 사용 중)
   src/lapis-entitlements.mjs   요금제 → 기능 판정 (잠금의 유일한 기준)
   src/groupware/org.mjs        회사·부서·구성원·초대
   src/groupware/messenger.mjs  방 목록·만들기·검색·파일 업로드 REST
   LapisChatRoom  (DO, 방마다 1개)      메시지 저장(DO SQLite)·순번·읽음 포인터·수정/회수
   LapisUserHub   (DO, 사람마다 1개)    그 사람의 WebSocket 1개, 방 알림을 모아 전달(안 보는 방의 숫자 갱신)

[이 PC] 4310 런타임 (라피스 통합 대시보드/src = ai-office-app dashboard/src 와 같은 구조)
   src/mail/  메일 브리지: IMAP 가져오기·IDLE, SMTP 보내기, Outlook(Graph)
              계정 비밀번호·토큰 → vault.mjs (DPAPI), 메일 캐시 → node:sqlite (data 폴더)
```

### 왜 이렇게 나눴나
- **메신저는 클라우드에 둔다.** 여러 사람이 서로 다른 PC와 웹에서 함께 쓰기 때문이다. 이미 파일 서버에서 DO 를 쓰고 있어 운영 방식이 같다.
- **메일은 PC 쪽에 둔다.**
  - 회사 메일 비밀번호를 클라우드에 두지 않는다. 이미 정한 「로그인 토큰은 PC별」 원칙과도 같다.
  - Gmail API 로 메일을 읽으려면 Google 보안 심사(CASA)가 필요하다. 이 심사는 비용과 시간이 든다. IMAP + 앱 비밀번호로 시작하면 심사 없이 바로 쓸 수 있다.
  - 대신 메일은 PC 가 켜져 있을 때만 보인다(웹 `/app` 도 같은 PC 의 브라우저에서만 보인다). 4단계에서 「클라우드 보관 메일(선택)」로 보완할 수 있다.
- **메일 라이브러리:** 4310 런타임은 npm 의존성이 없다. 그래서 `imapflow`·`nodemailer`·`mailparser` 를 esbuild 로 한 파일(`src/mail/vendor.mjs`)로 묶어 넣는다. 라이선스는 모두 MIT 이고 고지 파일을 함께 둔다.
- **이름 충돌 주의:** 엔진에는 이미 「조직 확정」(봇 조직)이 있다. 그룹웨어 쪽은 코드에서 `gw_org`, 화면에서 「회사」로 부른다.

## 4. 유료 잠금

### 4.1 원칙
- **판정은 서버가 한다.** 워커가 판정하고, 4310 메일 브리지는 워커의 판정을 받아 쓴다. 화면의 자물쇠는 안내일 뿐이다.
- 에디터에 이미 있는 **설정 잠금**(`AccessDecision`·`access-locks.ts`, 온보딩 미완료 시 쓰기 금지)과는 별개다.
  - 섞지 않는다. 다만 「서버가 준 이유·해제 방법 문장을 그대로 보여 준다」는 방식은 같게 쓴다(`explainLock` 과 같은 모양).
- 요금제는 기존 `lapis_subscriptions` 의 `free / basic / pro / team` 을 그대로 쓴다. 결제는 지금처럼 관리자 장부다.
- 회사 단위 요금제(`lapis_gw_org_subscriptions`)를 추가한다. 회사 요금제와 개인 요금제가 다르면 **높은 쪽을 적용**한다.
- 개별 예외는 `lapis_feature_overrides` 에 둔다(체험판, 특정 고객에게만 기능 열기, 만료일 지정).
- 전역 스위치는 wrangler vars 의 `LAPIS_PAYWALL`(`off` | `on`)이다. **지금은 `off`.**
  - `off` 에서는 전부 허용한다. 대신 「켰다면 막혔을 일」을 `wouldBlock` 으로 하루 단위 집계한다.
  - 응답에는 `requiredPlan` 을 실어 보낸다. 화면은 작은 「유료 예정」 표시를 할 수 있고, 기본값은 숨김이다.

### 4.2 판정 계약
```
GET /api/v1/lapis/entitlements
→ { paywall:'off', plan:'free', orgPlan:'pro'|null, effectivePlan:'pro',
    features:{ 'gw.mail':{allowed:true, requiredPlan:'free', limit:1, used:0,
                          reason?:'…', howToUnlock?:'…'} , … } }

막힘(402) → { code:'FEATURE_LOCKED', feature:'gw.approval', requiredPlan:'pro',
              limit?:30, used?:30, reason:'전자결재는 pro 요금제부터 쓸 수 있어요.',
              howToUnlock:'관리자에게 요금제 변경을 문의하세요.' }
```
- 워커:
  - `entitlements(env, user, orgId)`: 판정 결과를 만든다.
  - `requireFeature(ctx, key, {count})`: 모든 그룹웨어 경로가 맨 처음에 부른다. 수량 한도는 `count` 로 검사한다.
- 4310: 판정을 10분 캐시한다. 오프라인이면 마지막 판정으로 72시간 버틴다. 그 뒤로는 메일 읽기만 허용한다.
- 화면:
  - `shell/entitlements.ts` 에 `can(key)` 와 `useFeature(key)` 를 둔다.
  - 공용 부품 `<FeatureGate feature>` 와 메뉴 자물쇠 아이콘을 둔다.
  - `api.ts` 가 402 `FEATURE_LOCKED` 를 한곳에서 받는다. 이유와 해제 방법을 보여 주고 「문의하기」(InquiryDock)를 연다.

### 4.3 기능 키와 요금제 (초안 — 가격·경계는 유료화 전에 확정)

| 기능 키 | 내용 | free | basic | pro | team |
|---|---|:-:|:-:|:-:|:-:|
| `gw.org` | 회사·조직도·초대 (인원) | 5명 | 10명 | 30명 | 무제한 |
| `gw.messenger` | 1:1·그룹·부서방, 멘션, 반응 | ✓ | ✓ | ✓ | ✓ |
| `gw.messenger.history` | 대화 보관 기간 | 30일 | 1년 | 무제한 | 무제한 |
| `gw.messenger.files` | 파일 공유 (회사 합계) | 1GB | 10GB | 100GB | 1TB |
| `gw.messenger.bot` | 대화방에 LAPIS 봇 부르기 | – | ✓ | ✓ | ✓ |
| `gw.messenger.guest` | 외부 게스트 | – | – | ✓ | ✓ |
| `gw.mail` | 메일 계정 연결·읽기·쓰기 (계정 수) | 1 | 3 | 10 | 10 |
| `gw.mail.ai` | 요약·답장 초안·할 일/일정 변환·브리핑 | – | ✓ | ✓ | ✓ |
| `gw.mail.rules` | 자동 분류·예약 발송 | – | – | ✓ | ✓ |
| `gw.board` | 회사 게시판·공지 | ✓ | ✓ | ✓ | ✓ |
| `gw.resource` | 회의실·장비 예약 | – | ✓ | ✓ | ✓ |
| `gw.approval` | 전자결재 | – | – | ✓ | ✓ |
| `gw.attendance` | 근태·휴가 | – | – | ✓ | ✓ |
| `gw.admin.audit` | 감사 로그·대화 내보내기·보존 정책 | – | – | – | ✓ |
| `gw.security` | 워터마크·캡처 경고·SSO | – | – | – | ✓ |

**보관 기간 원칙:** 기간이 지나도 데이터를 바로 지우지 않는다. 화면에서 가리기만 하고, 요금제를 올리면 다시 보인다. 실제 삭제는 team 의 보존 정책을 켰을 때만 한다.

## 5. 데이터

### 5.1 D1 (마이그레이션 `migrations-lapis/2026-10-xx-groupware.sql`)
| 표 | 주요 열 |
|---|---|
| `lapis_gw_orgs` | id, name, owner_id, created_at, settings(json) |
| `lapis_gw_departments` | id, org_id, parent_id, name, sort |
| `lapis_gw_members` | org_id, user_id, dept_id, title(직급), position(직책), role(owner/admin/member/guest), status(근무/회의/외근/휴가), status_until, joined_at, left_at |
| `lapis_gw_invites` | id, org_id, email, role, dept_id, token_hash, expires_at, accepted_at, created_by |
| `lapis_gw_rooms` | id, org_id, kind(dm/group/dept/notice), title, dept_id, last_seq, last_preview, last_at, created_by |
| `lapis_gw_room_members` | room_id, user_id, role, last_read_seq, muted, pinned, joined_at, left_at |
| `lapis_gw_message_fts` | FTS5 (room_id, seq, body) — 검색용 사본. 회수하면 같이 지운다. |
| `lapis_gw_files` | id, org_id, room_id, r2_key, name, size, mime, uploaded_by, created_at |
| `lapis_gw_org_subscriptions` | org_id, plan, status, renews_at, note, updated_by |
| `lapis_feature_overrides` | scope(user/org), scope_id, feature, allow, limit, until, note, updated_by |
| `lapis_entitlement_daily` | day, feature, would_block, blocked (`off` 기간 영향 집계) |
| `lapis_gw_mail_accounts_meta` | user_id, account_id, provider, address, label, last_sync_at — **표시 정보만, 비밀번호 없음** |

### 5.2 Durable Objects
- `LapisChatRoom` (`idFromName(orgId:roomId)`)
  - SQLite 표 `messages(seq, author, kind, body, reply_to, edited_at, recalled_at, files, created_at)`, `reactions`, `pins`
  - 받은 메시지에 순번을 매긴다. D1 요약(`last_seq·last_preview`)을 갱신하고, 구성원 `LapisUserHub` 에 알린다.
  - 「안 읽은 사람 수」 = 구성원 중 `last_read_seq < seq` 인 사람 수. 읽음 포인터를 방 구독자에게 실시간으로 보낸다.
- `LapisUserHub` (`idFromName(userId)`)
  - WebSocket hibernation 으로 그 사람의 연결 1~N개(에디터, 웹)를 들고 있는다.
  - 방 알림, 상태 변경, 초대 같은 이벤트를 전달한다.

### 5.3 4310 런타임 (이 PC)
- `vault.mjs`(DPAPI): `mail.accounts[]` — 호스트·포트·아이디·비밀번호 또는 OAuth 토큰
- `data/mail.sqlite`(node:sqlite): 폴더, 메일 머리글, 최근 본문 캐시(계정당 최대 2,000통 / 200MB), 첨부는 열 때만 받는다.

## 6. API

**워커 `/api/v1/lapis/gw/*`** (모두 로그인 + `requireFeature` + 회사 구성원 확인)
- 조직:
  - `GET /orgs/mine`, `POST /orgs`
  - `GET /orgs/:org/directory`(조직도)
  - `POST /orgs/:org/departments`, `PATCH /orgs/:org/members/:user`
  - `POST /orgs/:org/invites`, `POST /invites/accept`
  - `PATCH /me/status`
- 메신저:
  - `GET /orgs/:org/rooms`, `POST /orgs/:org/rooms`, `POST /rooms/:room/members`
  - `GET /rooms/:room/messages?before=seq`, `POST /rooms/:room/messages`
  - `PATCH /rooms/:room/messages/:seq`(수정·회수), `POST /rooms/:room/read`
  - `POST /rooms/:room/files`(R2 업로드, 크기·용량 한도), `GET /files/:id`
  - `GET /orgs/:org/search?q=`
- 실시간: `GET /realtime`(WebSocket 업그레이드 → 내 `LapisUserHub`). 인증은 짧은 수명의 1회용 표를 `POST /realtime/ticket` 으로 받아 쓴다(토큰을 주소에 싣지 않기 위해).
- 잠금:
  - `GET /api/v1/lapis/entitlements`
  - 관리자용 `GET/POST /api/v1/lapis/admin/entitlements/*`(회사 요금제·예외·집계)

**4310 런타임 `/api/mail/*`** (로그인 + 판정 캐시 확인. 에디터는 local-bridge 허용 목록, 웹은 web-access 같은 계정 규칙)
- 계정:
  - `GET /accounts`
  - `POST /accounts`(연결 확인 후 저장)
  - `DELETE /accounts/:id`
  - `POST /accounts/:id/oauth/start|poll`(Outlook 장치 코드 로그인)
- 메일:
  - `GET /folders`, `GET /messages?account&folder&cursor&q`
  - `GET /messages/:id`(본문, 안전 처리됨), `GET /messages/:id/attachments/:part`
  - `POST /send`(보내기 전 화면에서 한 번 더 확인), `POST /messages/:id/flags`(읽음·별표·이동)
- AI·연결:
  - `POST /messages/:id/summary`, `POST /messages/:id/draft-reply`
  - `POST /messages/:id/to-task`, `POST /messages/:id/to-event`(기존 `tasks.mjs`·`calendar.mjs`)
  - `POST /messages/:id/share`(메신저 방으로 요약 + 링크 공유. 원문은 보내지 않는다)
- 이벤트: 새 메일이 오면 기존 화면 이벤트 경로로 숫자를 갱신하고 알림을 띄운다.

## 7. 화면 (editor-office)

- **메뉴**(`shell/nav.ts`): 「소통」 묶음을 메신저 · 메일 · 조직도 · 공지사항으로 늘린다. `PageId` 에 `messenger`·`mail`·`org` 를 추가한다. 잠긴 기능은 메뉴에 자물쇠를 붙이되 숨기지는 않는다.
- **메신저** `pages/MessengerPage.tsx`
  - 왼쪽: 방 목록(고정·안 읽은 수·검색). 가운데: 대화. 오른쪽: 방 정보(구성원·파일·공지).
  - 입력창에 멘션 자동 완성, 파일 끌어 놓기, 답글, 반응을 넣는다.
  - 메시지마다 안 읽은 사람 숫자를 보여 주고, 누르면 읽은 사람·안 읽은 사람 목록이 나온다.
- **메일** `pages/MailPage.tsx`
  - 계정·폴더 목록, 메일 목록, 읽기 창(격리 iframe), 쓰기 창(받는 사람 자동 완성은 조직도 + 최근 주소).
  - 상단에 「요약」·「답장 초안」·「할 일로」·「일정으로」·「메신저로 공유」 버튼을 둔다.
  - 계정 연결 마법사: 네이버·다음·Gmail(앱 비밀번호 안내 포함)·Outlook·직접 입력.
- **조직도** `pages/OrgPage.tsx`
  - 부서 트리와 구성원 카드(상태, 「대화」·「메일」 버튼).
  - 관리자는 부서와 구성원을 편집하고 초대한다.
- **오늘**(`TodayPage`) 카드: 안 읽은 메시지, 중요 메일 브리핑, 오늘 상태.
- **관리자**(`AdminPage`) 「요금제」 탭: 회사별 요금제, 기능 예외, `wouldBlock` 집계, 스위치 상태(보기만).
- **알림**
  - 에디터: Windows 알림과 작업 표시줄 숫자(overlay icon). 알림을 누르면 해당 방이나 메일이 열린다.
  - 웹: 브라우저 알림(사용자가 허용한 경우).
  - 방마다 알림 끄기가 있고, 근무 외 시간 방해 금지를 둔다.

## 8. 단계와 완료 기준

각 단계는 「자동 테스트 통과 → 로컬 확인 → 사용자 확인 → 배포」 순서로 진행한다. 배포(워커·에디터·엔진)는 늘 그렇듯 사용자의 「배포 진행」을 받은 뒤에 한다.

### 0단계 — 기반: 잠금 + 회사·조직도
- 워커: `lapis-entitlements.mjs`, `groupware/org.mjs`, 마이그레이션, 초대 메일(Cloudflare Email Service. 바인딩이 아직 없으면 초대 링크 복사로 대체).
- 에디터: `entitlements.ts`, `<FeatureGate>`, 402 처리, 조직도 화면, 관리자 「요금제」 탭.
- **완료 기준**
  - [ ] 판정표 테스트: `off`/`on`, 한도 초과, 개별 예외·만료, 회사·개인 요금제 중 높은 쪽 적용.
  - [ ] 다른 회사의 데이터가 보이지 않는 것(구성원 확인)을 테스트한다.
  - [ ] 두 계정으로 회사 만들기 → 초대 → 수락 → 조직도에 표시되는지 확인한다(웹 `/app` 두 창).

### A1 — 메신저 핵심
- `LapisChatRoom`·`LapisUserHub` DO, 메시지 REST, 실시간 연결(에디터 본체 소켓 + ipc, 웹 직접 연결), 끊기면 다시 연결하고 놓친 순번부터 이어 받기.
- 1:1·그룹 방, 보내기·불러오기, 안 읽은 사람 숫자, 방 목록의 안 읽은 수, 데스크톱 알림.
- **완료 기준**
  - [ ] DO 단위 테스트(vitest + workers pool): 순번, 읽음 포인터, 중복 전송 막기(클라이언트 id).
  - [ ] 두 창 실시간 E2E: 보내자마자 상대 창에 나타나고, 상대가 읽으면 숫자가 줄어드는지.
  - [ ] 네트워크를 끊었다 다시 연결해도 메시지가 빠지지 않는지.

### A2 — 메신저 기업 기능
- 수정·회수, 답글, 반응, 멘션, 공지 고정, 부서방 자동 구성, 파일(R2, 용량 한도), 검색(FTS5), 상태 표시, `@봇` 호출(엔진의 openTrigger 방식으로 런타임에 전달), 보관 기간 가리기.
- **완료 기준**
  - [ ] 회수한 메시지는 검색 사본에서도 사라지는지.
  - [ ] 파일 한도를 넘으면 402 와 안내가 뜨는지(`on` 으로 바꿔 시험).
  - [ ] 봇이 방에서 답하는지.

### B1 — 메일 읽기
- 4310 `src/mail/`: 계정 연결 마법사(네이버·다음·Gmail 앱 비밀번호·직접 입력), 폴더, 목록, 본문(안전 처리), 첨부 받기, 검색, IDLE 로 새 메일 알림, 통합 받은편지함.
- local-bridge 와 web-access 허용 목록에 `/api/mail/*` 를 추가한다.
- **완료 기준**
  - [ ] 가짜 IMAP 서버(테스트용)로 가져오기·IDLE·끊김 복구를 자동 테스트한다.
  - [ ] 본문 안전 처리 테스트: 스크립트·원격 이미지·폼이 실행되지 않는지.
  - [ ] 비밀번호가 화면, 로그, 클라우드 어디에도 나가지 않는지 검사한다.
  - [ ] 사용자가 실제 메일 계정 하나를 직접 연결해 확인한다(비밀번호는 사용자가 입력).

### B2 — 메일 쓰기·AI·Outlook
- SMTP 보내기(보내기 전 확인), 답장·전달·서명, Outlook(Graph 장치 코드 로그인 — Azure 앱 등록 필요), AI 요약·답장 초안·할 일/일정 변환, 메신저 공유.
- **완료 기준**
  - [ ] 가짜 SMTP 로 보내기를 테스트한다.
  - [ ] 할 일·일정이 기존 화면에 나타나는지.
  - [ ] 메신저 공유에 원문이 아닌 요약만 가는지.
  - [ ] 실제 발송은 사용자가 직접 한 번 확인한다.

### C — 그룹웨어 홈·통합 (A·B 를 마친 뒤)
- 「오늘」 카드, 통합 검색(메신저·메일), 조직도 카드의 「대화」·「메일」 바로가기, 상태 자동 표시(일정에 회의가 있으면 「회의 중」).

### 3단계 — 다우오피스 확장
- 게시판·공지(기존 공지를 회사 단위로 넓히고 댓글·읽은 사람 추가)
- 회의실·장비 예약(창고 대여의 예약 로직 참고)
- 전자결재(양식·결재선·합의·참조·대결/전결·결재함·PDF)
- 근태·휴가(출퇴근, 휴가 신청 → 결재, 연차 계산)

### 4단계 — 기업용(team)
- 관리자 콘솔(CSV 일괄 등록, 퇴사자 인계), 감사 로그, 대화 내보내기, 보존 정책
- 외부 게스트, 워터마크·캡처 경고, SSO(Google Workspace / Microsoft Entra)
- 모바일 PWA, 클라우드 보관 메일(선택)

## 9. 출시물과 기록

| 단계 | 워커 | 에디터 | 4310 런타임 / 엔진 |
|---|---|---|---|
| 0 | 마이그레이션 + 배포, DEPLOYMENT.md 기록 | preview.N (R2 + 웹 /app 자동) | – |
| A1·A2 | DO 클래스 추가(wrangler migrations `new_sqlite_classes`) | preview.N+1, N+2 | – |
| B1·B2 | entitlements 경로만 | 메일 화면 | 4310 런타임은 에디터 설치본에 포함. ai-office-app dashboard 에도 같은 코드를 넣고 GitHub 릴리스 |

- `LAPIS_PAYWALL` 은 출시 내내 `off` 로 둔다.
- 유료화 순서:
  1. 가격과 요금제 경계를 확정한다.
  2. 관리자 화면에서 `wouldBlock` 으로 영향을 확인한다.
  3. 기존 사용자에게 공지한다(유예 기간).
  4. `on` 으로 바꾼다.
- 카드 자동 결제는 PG 계약이 있어야 한다. 그 전까지는 관리자 장부로 요금제를 지정한다.
- editor-office 와 4310 런타임은 git 밖에 있다. 바꾸기 전에 백업(`C:/lapisbuild/before-groupware-…`)하고, staged copy 로 빌드한다.

## 10. 남은 결정 (구현을 막지는 않음)
1. 요금제 경계·가격(4.3 표는 초안).
2. Gmail API 공식 연동을 위한 Google 보안 심사를 진행할지(그 전까지는 앱 비밀번호 IMAP).
3. Outlook 연결용 Azure 앱 등록(무료, 사용자 Microsoft 계정으로 한 번만) — B2 전에 필요.
4. 초대 메일 발송 주소(도메인). Cloudflare Email Service 를 쓰려면 도메인 인증(SPF/DKIM)이 필요하다.

## 11. 위험과 대응
- **실시간 비용**: hibernation 으로 대기 비용을 줄이고, 방 알림은 묶어서 보낸다. 요금제 인원 한도로 상한을 둔다.
- **메일 보안**: 비밀번호와 본문은 PC 에만 둔다. 로그에 남기지 않는다. 본문은 격리 iframe 으로 보이고 원격 이미지는 기본 차단한다. 보내기는 늘 한 번 더 확인한다.
- **개인정보**: 회사 단위 대화 저장은 처리 위탁이 된다. 유료화 전에 이용약관·개인정보 처리방침을 보완하고, 퇴사·탈퇴 시 처리 규칙을 정한다.
- **두 복사본**: 4310 런타임(라피스 통합 대시보드)과 ai-office-app dashboard 가 갈라지지 않도록, 메일 브리지는 한쪽에서 만들고 같은 파일을 복사한다. 차이 검사 스크립트를 둔다.
- **오프라인**: 메신저는 클라우드에 연결돼 있어야 쓸 수 있다. 끊기면 화면에 표시하고, 쓰던 메시지는 보관했다가 다시 연결되면 보낸다.

## 12. 구현 현황 (2026-10-13, 사용자 「1~11 진행」)

코드·시험·묶음까지 마쳤다. **운영 배포(워커·D1·에디터 R2·엔진 릴리스)는 하지 않았다** — 사용자 「배포 진행」을 기다린다.

| 영역 | 상태 | 위치 |
|---|---|---|
| 0단계 잠금 + 회사·조직도 | 완료 | 워커 `src/groupware/entitlements.mjs`·`org.mjs`, 에디터 `GroupwareContext.tsx`·`pages/groupware/OrgPage.tsx`·`PlansAdmin.tsx` |
| A1·A2 메신저 | 완료 | 워커 `messenger.mjs`·`hub.mjs`, 에디터 `MessengerPage.tsx`, 본체 `main/groupware.ts`·`shared/groupware-realtime.ts` |
| B1·B2 메일 | 완료(Outlook 은 Azure 앱 등록 필요) | 4310 `src/mail/*`(라피스 통합 대시보드 + 이 저장소 `dashboard/src/mail`), 에디터 `MailPage.tsx` |
| C 홈·통합 검색 | 완료 | 「오늘」 카드 2개(`HomeCards.tsx`·`MailCard`), 상단 찾기 |
| 3단계 게시판·예약·결재·근태 | 완료 | 워커 `work.mjs`, 에디터 `BoardPage`·`ReservationPage`·`ApprovalPage`·`AttendancePage` |
| 4단계 기업용 | 일부 | 완료: CSV 일괄 초대, 퇴사 처리(결재·방장 인계), 감사 기록, 대화 내보내기(CSV), 보존 정책(매일 cron), 외부 게스트, 워터마크, 캡처 방지. **안 함**: SSO(Google Workspace/Entra), 모바일 PWA, 클라우드 보관 메일 |

계획과 달라진 점
- 메시지는 방마다 DO 대신 **D1** 에 둔다(순번은 같은 batch 에서 `last_seq+1`). DO 는 사람마다 하나(`LapisGwHub`)만 두어 실시간 연결만 맡는다. 검색은 한국어 부분 일치가 필요해 FTS5 대신 `LIKE`(내가 속한 방 안에서만).
- 초대 메일 발송은 하지 않는다(보낼 도메인 미정). 초대 코드 + 「안내문 복사」로 대신한다.
- 메일 첨부는 받을 때 5MB(에디터 본체 응답 한도), 보낼 때 합쳐 15MB.

검증
- 워커 77/77(그룹웨어 17), 4310 런타임 122 통과·0 실패(메일 프로토콜 시험 6개는 `MAIL_TEST_DEPS` 로 시험용 IMAP/SMTP 를 줄 때 실행), 이 저장소 대시보드 87 통과·0 실패, 에디터 vitest 1187/1187, 타입 검사 통과, `wrangler deploy --dry-run` 통과.
- 화면 실제 확인(빌드한 에디터 웹 화면 + 실제 워커 코드 + 실시간 + 실제 메일 브리지, 두 사람 동시 접속): 실시간 메시지·읽음 숫자, `@라피스` 답, 결재 합의 → 다음 결재자 알림, 메일 계정 연결·읽기(원격 이미지 차단)·AI 요약·할 일/일정 넣기·메신저 공유·답장 발송(SMTP)·새 메일 IDLE, 스위치 「켬」에서 메뉴 자물쇠·잠금 카드, 운영자가 회사 요금제를 올리면 즉시 풀림.

배포할 때 순서: 워커(`ciel-worker-api/DEPLOYMENT.md` 「그룹웨어」) → 에디터 preview.32(`editor-office/BUILD-WINDOWS.md` 「preview.32」) → 이 저장소 대시보드 메일 브리지는 다음 엔진 릴리스에 포함.
