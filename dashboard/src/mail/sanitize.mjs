// 메일 본문 HTML 을 화면에 보여 주기 전에 위험한 것을 걷어 낸다.
// 화면은 이 결과를 다시 스크립트가 꺼진 격리 iframe(sandbox, CSP)에 넣는다 — 여기는 두 겹 중 첫 겹이다.
// 원격 이미지·CSS 는 기본으로 막는다(보낸 사람이 「열어 봤는지」 알 수 있게 하는 추적 픽셀 때문). cid: 첨부 이미지는 data: 로 바꿔 보여 준다.
const DROP_BLOCKS=/<(script|style\s+[^>]*?src|iframe|frame|frameset|object|embed|applet|noscript|template|svg|math|form|button|textarea|select)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_TAGS=/<\/?(script|iframe|frame|frameset|object|embed|applet|base|link|meta|form|input|button|textarea|select|option|noscript|template|svg|math|portal|xml|param)\b[^>]*>/gi;
const EVENT_ATTR=/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const BAD_URL=/\s+(href|src|action|formaction|xlink:href|background|poster|srcset|lowsrc|dynsrc)\s*=\s*("\s*(?:javascript|vbscript|data:text\/html|livescript)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html|livescript)[^']*'|(?:javascript|vbscript|livescript):[^\s>]*)/gi;
const REMOTE_SRC=/\s(src|background|poster|srcset)\s*=\s*("\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*'|(?:https?:)?\/\/[^\s>]+)/gi;
const REMOTE_CSS_URL=/url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;
const CSS_EXPR=/expression\s*\(|behavior\s*:|-moz-binding/gi;
const IMPORT=/@import[^;]*;?/gi;

export function sanitizeHtml(html,{cid={},allowRemote=false}={}){
  let out=String(html||'');
  if(out.length>2_000_000)out=out.slice(0,2_000_000);
  out=out.replace(/<!--[\s\S]*?-->/g,'');
  for(let i=0;i<3;i++)out=out.replace(DROP_BLOCKS,'');
  out=out.replace(DROP_TAGS,'');
  out=out.replace(EVENT_ATTR,'');
  out=out.replace(BAD_URL,'');
  out=out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,(_,a,css,c)=>a+css.replace(IMPORT,'').replace(CSS_EXPR,'').replace(allowRemote?/$^/:REMOTE_CSS_URL,'none')+c);
  out=out.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi,m=>m.replace(CSS_EXPR,'').replace(allowRemote?/$^/:REMOTE_CSS_URL,'none'));
  // cid: 로 가리킨 본문 속 이미지를 data: 로
  out=out.replace(/\ssrc\s*=\s*(["'])cid:([^"']+)\1/gi,(m,q,ref)=>{const data=cid[ref.trim()]||cid['<'+ref.trim()+'>'];return data?` src=${q}${data}${q}`:'';});
  let blocked=0;
  if(!allowRemote)out=out.replace(REMOTE_SRC,(m,attr)=>{blocked++;return ` data-lapis-blocked-${attr.toLowerCase()}=""`;});
  // 링크는 새 창으로(격리 iframe 안에서는 눌러도 아무 데도 가지 않는다)
  out=out.replace(/<a\b/gi,'<a rel="noopener noreferrer" target="_blank"');
  return {html:out,blockedRemote:blocked};
}
export function textToHtml(text){
  const esc=String(text||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<pre style="white-space:pre-wrap;word-break:break-word;font:inherit;margin:0">${esc}</pre>`;
}
