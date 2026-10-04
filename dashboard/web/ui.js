// 통합 화면의 공통 부품: DOM 도우미, 서버 호출, 알림, 확인 창, 페이지 등록.
export const q=(s,root=document)=>root.querySelector(s);
export const qa=(s,root=document)=>[...root.querySelectorAll(s)];
export const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
export const put=(parent,...children)=>{parent.append(...children.filter(c=>c!==null&&c!==undefined&&c!==false));return parent;};
export const link=(text,href,cls='')=>{const a=node('a',cls,text);a.href=href;if(/^https:\/\//.test(href)){a.target='_blank';a.rel='noopener noreferrer';a.title='새 탭에서 열기';}return a;};
export const button=(text,action,cls='btn')=>{const b=node('button',cls,text);b.type='button';if(action)b.addEventListener('click',action);return b;};
export const pill=(text,cls='')=>node('span','pill '+cls,text);
export const emptyLine=text=>node('p','empty-line',text);
export const friendly=(title,detail,action)=>{const box=node('div','friendly-empty');put(box,node('h3','',title),detail?node('p','',detail):null,action);return box;};
export const errorText=e=>typeof e==='string'?e:e?.message||'요청을 처리하지 못했습니다.';
export const fmtDate=(v,opts={month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})=>{if(!v)return '기록 없음';const d=new Date(v);return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat('ko-KR',opts).format(d);};
export const fmtBytes=n=>n==null?'':n>=1e9?(n/1e9).toFixed(1)+' GB':n>=1e6?(n/1e6).toFixed(1)+' MB':n>=1e3?Math.round(n/1e3)+' KB':n+' B';
export const dayKey=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');

// 서버(이 대시보드) 호출. 변경 요청에는 화면에서 보낸 것이라는 표시를 붙인다.
export async function api(path,{method='GET',body,timeout}={}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeout||(method==='GET'?25000:190000));
  try{
    const response=await fetch(path,{method,signal:controller.signal,credentials:'same-origin',
      headers:method==='GET'?{}:{'content-type':'application/json','x-lapis-request':'1'},
      body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(response.status===401&&data.error==='로그인이 필요해요.'&&!path.startsWith('/api/cloud/')){setTimeout(()=>location.reload(),300);}   // 로그인이 풀렸으면 로그인 화면으로
    if(!response.ok){const e=new Error(data.error||data.message||'요청 실패 ('+response.status+')');e.status=response.status;throw e;}
    return data;
  }catch(e){if(e.name==='AbortError')throw new Error('응답이 늦어지고 있습니다. 잠시 뒤 다시 시도해 주세요.');throw e;}
  finally{clearTimeout(timer);}
}
export const cloud=(method,path,body)=>api('/api/cloud'+path,{method,body});

// 알림(Office 화면과 같은 #toast 를 쓴다)
let toastTimer;
export function toast(message,bad=false){
  const t=q('#toast');t.textContent=message;t.className='toast show'+(bad?' bad':'');
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.className='toast';},bad?5200:3200);
}
export async function doing(btn,fn){
  if(btn)btn.disabled=true;
  try{return await fn();}catch(e){toast(errorText(e),true);return null;}finally{if(btn)btn.disabled=false;}
}

// 이 화면 전용 대화상자(#ui-dlg). Office 화면의 #dlg 와 따로 쓴다.
export function openDialog(build,{wide=false}={}){
  const dlg=q('#ui-dlg');dlg.replaceChildren();dlg.className=wide?'wide':'';
  const box=node('div','dlg');dlg.append(box);build(box,()=>dlg.close());
  if(!dlg.open)dlg.showModal();return dlg;
}
export const closeDialog=()=>{const d=q('#ui-dlg');if(d.open)d.close();};
export function confirmDialog({title,body,ok='확인',danger=false}){
  return new Promise(resolve=>{
    let settled=false;const finish=v=>{if(!settled){settled=true;resolve(v);}};
    const dlg=openDialog((box,close)=>{
      put(box,put(node('div','dlg-head'),node('h2','',title),node('p','',body)),
        put(node('div','dlg-foot'),button('취소',()=>{finish(false);close();}),button(ok,()=>{finish(true);close();},'btn '+(danger?'danger':'primary'))));
    });
    dlg.addEventListener('close',()=>finish(false),{once:true});
  });
}

// 페이지 등록: lapis.js 의 이동 처리기가 화면을 열 때 show() 를 부른다.
export const pages={};
export const registerPage=(name,page)=>{pages[name]=page;};
export const field=(label,input,hint)=>{const f=node('div','field');put(f,node('label','',label),input,hint?node('span','hint',hint):null);return f;};
export const input=(attrs={})=>{const i=node('input');Object.assign(i,{type:'text'},attrs);return i;};
export const select=(options,value)=>{const s=node('select');for(const [v,t] of options){const o=node('option','',t);o.value=v;s.append(o);}if(value!==undefined)s.value=value;return s;};
export const textarea=(attrs={})=>Object.assign(node('textarea'),attrs);
// 서버가 돌려준 값만 이 화면에서 쓰는 주소(https)로 열 수 있게 한다.
export const safeHttps=u=>{try{const x=new URL(u);return x.protocol==='https:'?x.href:null;}catch{return null;}};
