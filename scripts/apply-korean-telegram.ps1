# 텔레그램 플러그인이 봇으로 보내는 영어 안내문(페어링·/start·/help·/status·권한 요청)을 한국어로 바꾼다.
# 플러그인이 업데이트되어 영어로 돌아오면 다시 실행한다:
#   powershell -ExecutionPolicy Bypass -File <설치폴더>\app\scripts\apply-korean-telegram.ps1
# 실행 후 대시보드에서 사무실을 다시 출근시켜야 적용된다. (여러 번 실행해도 안전하다)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.claude\plugins\cache\claude-plugins-official\telegram'
$pairs = @(
  @('"Paired! Say hi to Claude."', '"페어링이 완료되었습니다! 비서실장에게 인사해 보세요. 👋"'),
  @("This bot bridges Telegram to a Claude Code session.\n\n", "이 봇은 텔레그램을 Claude Code 사무실(비서실장)과 연결해 줍니다.\n\n"),
  @("To pair:\n", "연결 방법:\n"),
  @("1. DM me anything — you'll get a 6-char code\n", "1. 저에게 아무 메시지나 보내 주세요. 6자리 코드를 알려 드립니다.\n"),
  @("2. In Claude Code: /telegram:access pair <code>\n\n", "2. AI-Office 대시보드 「연결 · 계정」에 그 코드를 입력하세요.\n   (Claude Code에서는 /telegram:access pair <코드>)\n\n"),
  @("After that, DMs here reach that session.", "연결 후에는 여기로 보낸 메시지가 비서실장에게 전달됩니다."),
  @("Messages you send here route to a paired Claude Code session. ", "여기로 보낸 메시지는 연결된 Claude Code 사무실로 전달됩니다. "),
  @("Text and photos are forwarded; replies and reactions come back.\n\n", "글과 사진이 전달되고, 답장과 반응이 돌아옵니다.\n\n"),
  @("/start — pairing instructions\n", "/start — 연결 방법 안내\n"),
  @("/status — check your pairing state", "/status — 연결 상태 확인"),
  @('Paired as ${name}.', '연결되어 있습니다: ${name}'),
  @('Pending pairing — run in Claude Code:\n\n/telegram:access pair ${code}', '연결 대기 중입니다. AI-Office 대시보드 「연결 · 계정」에 이 코드를 입력하세요:\n\n${code}\n\n(Claude Code에서는 /telegram:access pair ${code})'),
  @('Not paired. Send me a message to get a pairing code.', '아직 연결되지 않았습니다. 저에게 메시지를 보내면 연결 코드를 알려 드립니다.'),
  @("'Still pending' : 'Pairing required'", "'아직 연결 대기 중입니다' : '연결이 필요합니다'"),
  @('${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}', '${lead}. AI-Office 대시보드 「연결 · 계정」에 이 코드를 입력하세요:\n\n${result.code}\n\n(Claude Code에서는 /telegram:access pair ${result.code})'),
  @("'Welcome and setup guide'", "'시작 안내와 연결 방법'"),
  @("'What this bot can do'", "'이 봇이 할 수 있는 일'"),
  @("'Check your pairing status'", "'연결 상태 확인'"),
  @('🔐 Permission: ${tool_name}', '🔐 권한 요청: ${tool_name}'),
  @(".text('See more'", ".text('자세히 보기'"),
  @(".text('✅ Allow'", ".text('✅ 허용'"),
  @(".text('❌ Deny'", ".text('❌ 거부'"),
  @("'Not authorized.'", "'권한이 없습니다.'"),
  @("'Details no longer available.'", "'자세한 내용을 더 이상 볼 수 없습니다.'"),
  @("tool_name: `${tool_name}\n", "도구: `${tool_name}\n"),
  @("description: `${description}\n", "설명: `${description}\n"),
  @("input_preview:\n`${prettyInput}", "입력 미리보기:\n`${prettyInput}"),
  @("'✅ Allowed' : '❌ Denied'", "'✅ 허용했습니다' : '❌ 거부했습니다'")
)
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($f in Get-ChildItem $root -Recurse -Filter server.ts -ErrorAction SilentlyContinue) {
  $text = [IO.File]::ReadAllText($f.FullName, $utf8); $orig = $text; $n = 0
  foreach ($p in $pairs) { if ($text.Contains($p[0])) { $text = $text.Replace($p[0], $p[1]); $n++ } }
  if ($text -ne $orig) {
    if (-not (Test-Path "$($f.FullName).orig-en")) { Copy-Item $f.FullName "$($f.FullName).orig-en" }
    [IO.File]::WriteAllText($f.FullName, $text, $utf8)
    "$($f.FullName): $n 곳을 한국어로 바꿨습니다."
  } else { "$($f.FullName): 바꿀 영어 문구가 없습니다(이미 적용됨)." }
}
