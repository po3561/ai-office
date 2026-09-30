# 텔레그램 플러그인(0.0.x)의 reply·edit_message 에 두 가지를 더한다.
#  1) format: 'html' 지원 — AI-Office 지침(CLAUDE.md)이 <b>·<blockquote> 같은 HTML 서식을 쓰도록 되어 있는데
#     공식 플러그인은 'text'·'markdownv2' 만 지원해서 태그가 글자 그대로 보이던 문제를 없앤다.
#  2) 서식 오류 자동 복구 — 텔레그램이 태그·이스케이프 오류(can't parse entities)로 거절하면 서식을 걷어내고
#     일반 글로 다시 보낸다. (메시지가 통째로 실패하지 않게 한다)
# 실행: powershell -ExecutionPolicy Bypass -File <설치폴더>\app\scripts\apply-telegram-html.ps1   (여러 번 실행해도 안전)
# 적용 후 대시보드에서 사무실을 다시 출근시켜야 한다. 플러그인이 업데이트되면 다시 실행한다.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.claude\plugins\cache\claude-plugins-official\telegram'
$utf8 = New-Object Text.UTF8Encoding($false)

$desc_old = @"
"Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed).",
"@.Trim()
$desc_new = @"
"Rendering mode. 'html' (recommended for formatted messages): <b>, <i>, <code>, <a href>, <blockquote> are rendered; write & < > as &amp; &lt; &gt; in normal text. 'markdownv2' needs heavy escaping (avoid). Default 'text' = plain (never put tags in text mode). If Telegram rejects the markup the message is automatically resent as plain text.",
"@.Trim()

$helpers = @'
// 서식(HTML·MarkdownV2)을 텔레그램이 거절하면 서식을 걷어내고 일반 글로 다시 보낸다.
const PARSE_ERR = /can't parse entities|can't find end of/i
const stripHtml = (t: string) => t.replace(/<\/?[a-z][^>]*>/gi, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
async function sendWithFallback(chat_id: string, text: string, opts: Record<string, unknown>) {
  try {
    return await bot.api.sendMessage(chat_id, text, opts as any)
  } catch (err) {
    if (!opts.parse_mode || !PARSE_ERR.test(String(err))) throw err
    const { parse_mode, ...rest } = opts
    return await bot.api.sendMessage(chat_id, parse_mode === 'HTML' ? stripHtml(text) : text, rest as any)
  }
}
async function editWithFallback(chat_id: string, message_id: number, text: string, opts?: { parse_mode: 'HTML' | 'MarkdownV2' }) {
  try {
    return await bot.api.editMessageText(chat_id, message_id, text, opts)
  } catch (err) {
    if (!opts?.parse_mode || !PARSE_ERR.test(String(err))) throw err
    return await bot.api.editMessageText(chat_id, message_id, opts.parse_mode === 'HTML' ? stripHtml(text) : text)
  }
}

'@
$callLine = 'mcp.setRequestHandler(CallToolRequestSchema, async req => {'

# @(찾을 문자열, 바꿀 문자열[, 이미 있으면 건너뛸 표식])
$pairs = @(
  @("enum: ['text', 'markdownv2'],", "enum: ['text', 'markdownv2', 'html'],"),
  @($desc_old, $desc_new),
  @("const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : undefined", "const parseMode = format === 'markdownv2' ? 'MarkdownV2' as const : format === 'html' ? 'HTML' as const : undefined"),
  @("const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : undefined", "const editParseMode = editFormat === 'markdownv2' ? 'MarkdownV2' as const : editFormat === 'html' ? 'HTML' as const : undefined"),
  @("const sent = await bot.api.sendMessage(chat_id, chunks[i], {", "const sent = await sendWithFallback(chat_id, chunks[i], {"),
  @("const edited = await bot.api.editMessageText(", "const edited = await editWithFallback("),
  @($callLine, ($helpers + $callLine), 'async function sendWithFallback(')
)

foreach ($f in Get-ChildItem $root -Recurse -Filter server.ts -ErrorAction SilentlyContinue) {
  $text = [IO.File]::ReadAllText($f.FullName, $utf8); $orig = $text; $n = 0
  foreach ($p in $pairs) {
    if ($p.Count -ge 3 -and $text.Contains($p[2])) { continue }
    if ($text.Contains($p[0])) { $text = $text.Replace($p[0], $p[1]); $n++ }
  }
  if ($text -ne $orig) {
    if (-not (Test-Path "$($f.FullName).before-html")) { Copy-Item $f.FullName "$($f.FullName).before-html" }
    [IO.File]::WriteAllText($f.FullName, $text, $utf8)
    "$($f.FullName): $n 곳을 고쳤습니다(html 서식 지원 + 서식 오류 자동 복구)."
  } else { "$($f.FullName): 이미 적용되어 있습니다." }
}
