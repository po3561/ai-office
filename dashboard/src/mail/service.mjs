// 메일 브리지: 이미 쓰는 메일 계정(IMAP/SMTP, Outlook)을 이 PC 에서 연결해 읽고 보낸다.
//
// 지키는 것
//  · 비밀번호·토큰은 DPAPI 금고(vault)에만 둔다. 화면·로그·클라우드로 보내지 않는다.
//  · 메일 머리글과 최근 본문만 이 PC 의 mail.sqlite 에 캐시한다. 클라우드에는 「어떤 주소를 연결했는지」만 알린다(한도 계산용).
//  · 보내기는 화면이 한 번 더 확인한 뒤에만 부른다(서버는 confirm:true 가 없으면 보내지 않는다).
//  · 요금제 판정은 클라우드(/lapis/entitlements)가 한다. 10분 기억하고, 서버에 닿지 않으면 72시간까지 마지막 판정을 쓴다.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {PRESETS,presetFor} from './presets.mjs';
import {sanitizeHtml,textToHtml} from './sanitize.mjs';

export class MailError extends Error{constructor(status,message,extra){super(message);this.status=status;this.extra=extra||null;}}
const fail=(status,message,extra)=>{throw new MailError(status,message,extra);};
const EMAIL=/^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[^\s@<>()",;:]{2,24}$/;
const LIST_LIMIT=200,BODY_CACHE=2000,MAX_ATTACH_SEND=15*1024*1024,MAX_ATTACH_READ=5*1024*1024;
const ENT_FRESH=10*60000,ENT_OFFLINE=72*3600000;
const b64url=s=>Buffer.from(s,'utf8').toString('base64url');
const unb64url=s=>Buffer.from(s,'base64url').toString('utf8');
const clean=(v,max)=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max);

const SCHEMA=`
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, preset TEXT NOT NULL, address TEXT NOT NULL, name TEXT, label TEXT, username TEXT NOT NULL,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_secure INTEGER NOT NULL, smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_secure INTEGER NOT NULL,
  save_sent INTEGER NOT NULL DEFAULT 1, signature TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_sync_at TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS folders (account_id TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, special TEXT, uidvalidity TEXT, total INTEGER NOT NULL DEFAULT 0, unseen INTEGER NOT NULL DEFAULT 0, synced_at TEXT, PRIMARY KEY (account_id, path));
CREATE TABLE IF NOT EXISTS messages (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, message_id TEXT, subject TEXT, from_name TEXT, from_addr TEXT, to_json TEXT, cc_json TEXT, date TEXT,
  seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0, has_att INTEGER NOT NULL DEFAULT 0, size INTEGER, snippet TEXT, in_reply_to TEXT, refs TEXT, added_at TEXT NOT NULL,
  PRIMARY KEY (account_id, folder, uid));
CREATE INDEX IF NOT EXISTS messages_date ON messages(account_id, folder, date);
CREATE INDEX IF NOT EXISTS messages_added ON messages(added_at);
CREATE TABLE IF NOT EXISTS bodies (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL, html TEXT, text TEXT, raw_html TEXT, attachments TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (account_id, folder, uid));
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, account_id TEXT, field TEXT NOT NULL, contains TEXT NOT NULL, action TEXT NOT NULL, target TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL, send_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', error TEXT, created_at TEXT NOT NULL, sent_at TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT, at INTEGER);
`;

function imapError(e){
  const m=String(e?.responseText||e?.message||'');
  if(e?.authenticationFailed||/auth|login|credential|password|invalid/i.test(m)&&!/certificate/i.test(m))return '아이디나 비밀번호(앱 비밀번호)가 맞지 않아요. 메일 서비스에서 IMAP 사용과 앱 비밀번호를 확인해 주세요.';
  if(e?.code==='ENOTFOUND'||e?.code==='EAI_AGAIN')return '메일 서버 주소를 찾을 수 없어요. 주소를 확인해 주세요.';
  if(e?.code==='ECONNREFUSED'||e?.code==='ETIMEDOUT'||/timeout/i.test(m))return '메일 서버에 연결하지 못했어요. 주소·포트와 인터넷 연결을 확인해 주세요.';
  if(/certificate|self.signed|CERT_/i.test(m)||/CERT/.test(e?.code||''))return '메일 서버의 보안 인증서를 확인하지 못했어요. 회사 메일이면 관리자에게 서버 주소를 다시 확인해 주세요.';
  return '메일 서버가 요청을 처리하지 못했어요'+(m?`: ${m.slice(0,160)}`:'.');
}
const specialOf=f=>{
  const s=f.specialUse||'';
  if(s)return s;
  const p=(f.path||'').toLowerCase();
  if(p==='inbox')return '\\Inbox';
  if(/sent|보낸/.test(p))return '\\Sent';if(/trash|deleted|휴지/.test(p))return '\\Trash';if(/draft|임시/.test(p))return '\\Drafts';if(/spam|junk|스팸/.test(p))return '\\Junk';if(/archive|보관/.test(p))return '\\Archive';
  return null;
};
function hasAttachment(node){
  if(!node)return false;
  if(node.disposition==='attachment')return true;
  return Array.isArray(node.childNodes)&&node.childNodes.some(hasAttachment);
}
const addrList=list=>(Array.isArray(list)?list:[]).map(a=>({name:clean(a.name,120),address:clean(a.address,254).toLowerCase()})).filter(a=>a.address);
function parseAddresses(value,label){
  const parts=(Array.isArray(value)?value:String(value||'').split(/[,;\n]/)).map(x=>String(x).trim()).filter(Boolean);
  if(parts.length>100)fail(400,`${label}은(는) 100명까지 넣을 수 있어요.`);
  return parts.map(p=>{
    const m=/^(.*)<([^>]+)>$/.exec(p);
    const address=(m?m[2]:p).trim().toLowerCase(),name=m?m[1].trim().replace(/^"|"$/g,''):'';
    if(!EMAIL.test(address))fail(400,`${label}의 주소 「${p.slice(0,60)}」가 올바르지 않아요.`);
    return {name,address};
  });
}
function privateAddress(ip){
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a===10||a===127||a===0||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||a>=224;}
  const v=ip.toLowerCase();return v==='::1'||v==='::'||v.startsWith('fc')||v.startsWith('fd')||v.startsWith('fe80')||v.startsWith('::ffff:127.')||v.startsWith('::ffff:10.')||v.startsWith('::ffff:192.168.');
}
const stripHtml=html=>String(html||'').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();

let vendorPromise=null;
const vendor=()=>vendorPromise||(vendorPromise=import('./vendor.mjs').then(m=>m.default));
export const defaultClients={
  async imap(options){const {ImapFlow}=await vendor();return new ImapFlow({...options,logger:false,emitLogs:false,socketTimeout:90000});},
  async smtp(options){const {nodemailer}=await vendor();return nodemailer.createTransport({...options,connectionTimeout:20000,greetingTimeout:15000,socketTimeout:60000});},
  async compose(message){const {nodemailer}=await vendor();const t=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'\r\n'});const info=await t.sendMail(message);return {raw:info.message,messageId:info.messageId,envelope:info.envelope};},
  async parse(source){const {simpleParser}=await vendor();return simpleParser(source,{skipImageLinks:true,skipTextLinks:true});},
};

export function createMailService({dataDir,vault,cloud,clients=defaultClients,now=()=>Date.now(),outlookClientId='',fetchImpl=fetch,resolveHost=lookup,watch=true}){
  // 메일 DB 는 처음 쓸 때 연다(메일을 연결하지 않은 PC 에는 파일도 만들지 않는다).
  let opened=null;
  const db=()=>{
    if(opened)return opened;
    const dir=join(dataDir,'mail');mkdirSync(dir,{recursive:true});
    opened=new DatabaseSync(join(dir,'mail.sqlite'));
    opened.exec('PRAGMA journal_mode=WAL;'+SCHEMA);
    return opened;
  };
  const hasDb=()=>Boolean(opened)||existsSync(join(dataDir,'mail','mail.sqlite'));
  const iso=()=>new Date(now()).toISOString();
  const q=(sql,...args)=>db().prepare(sql).all(...args);
  const one=(sql,...args)=>db().prepare(sql).get(...args)??null;
  const run=(sql,...args)=>db().prepare(sql).run(...args);
  let version=0;
  const recent=[];   // 화면 알림용: 최근에 새로 들어온 받은편지함 메일
  const outlookAttempts=new Map();

  // ── 비밀 값(DPAPI 금고) ──
  async function secrets(){return (await vault.read()).mailSecrets||{};}
  async function secretOf(id){return (await secrets())[id]||null;}
  async function saveSecret(id,value){const all=await secrets();if(value)all[id]=value;else delete all[id];await vault.update({mailSecrets:all});}

  // ── 요금제 판정(클라우드) ──
  async function entitlements({force=false}={}){
    const cached=one(`SELECT value, at FROM meta WHERE key = 'entitlements'`);
    if(cached&&!force&&now()-cached.at<ENT_FRESH)return JSON.parse(cached.value);
    try{
      const result=await cloud.call('GET','/lapis/entitlements');
      if(result.status===401)fail(401,'라피스 계정에 로그인해 주세요.');
      if(result.status<200||result.status>=300)throw new Error('status '+result.status);
      const data=JSON.parse(result.text);
      run(`INSERT INTO meta (key, value, at) VALUES ('entitlements', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at`,JSON.stringify(data),now());
      return data;
    }catch(error){
      if(error instanceof MailError)throw error;
      if(error?.status===401)fail(401,'라피스 계정에 로그인해 주세요.');
      if(cached&&now()-cached.at<ENT_OFFLINE)return {...JSON.parse(cached.value),offline:true};
      fail(503,'라피스 서버에 닿지 않아 이용 권한을 확인하지 못했어요. 인터넷 연결을 확인해 주세요.',{code:'ENTITLEMENT_OFFLINE'});
    }
  }
  async function gate(feature,{count=0,readOnly=false}={}){
    let e;
    try{e=await entitlements();}catch(error){if(readOnly&&error.status===503)return;throw error;}
    const f=e?.features?.[feature];
    if(!f)return;
    const over=count>0&&e.paywall==='on'&&f.limit!==null&&f.limit!==undefined&&Number(f.used||0)+count>f.limit;
    if(f.allowed===false||over)fail(402,f.reason||`${f.label||'이 기능'} 한도를 넘어요.`,{code:'FEATURE_LOCKED',feature,requiredPlan:f.requiredPlan,limit:f.limit,used:f.used,howToUnlock:f.howToUnlock});
  }
  async function reportAccount(account,{remove=false}={}){
    try{
      const result=remove?await cloud.call('DELETE','/lapis/gw/mail/accounts/'+encodeURIComponent(account.id)):await cloud.call('POST','/lapis/gw/mail/accounts',{body:{accountId:account.id,provider:account.provider==='outlook'?'outlook':account.preset==='gmail'?'gmail':'imap',address:account.address,label:account.label||null,lastSyncAt:account.last_sync_at||null}});
      if(result.status===402){const d=JSON.parse(result.text||'{}');fail(402,d.error||'메일 계정 한도를 넘어요.',{code:'FEATURE_LOCKED',feature:'gw.mail',requiredPlan:d.requiredPlan,howToUnlock:d.howToUnlock});}
      run(`DELETE FROM meta WHERE key = 'entitlements'`);
    }catch(error){if(error instanceof MailError)throw error;/* 표시 정보 알림 실패는 메일 사용을 막지 않는다 */}
  }

  // ── Outlook(Microsoft) OAuth: 장치 코드 로그인 ──
  const MS='https://login.microsoftonline.com/common/oauth2/v2.0';
  const MS_SCOPE='offline_access openid email profile https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';
  async function msPost(path,form){
    const res=await fetchImpl(MS+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),signal:AbortSignal.timeout(20000)});
    return {status:res.status,data:await res.json().catch(()=>({}))};
  }
  async function outlookToken(account){
    const secret=await secretOf(account.id);
    if(!secret?.oauth?.refreshToken)fail(401,'Outlook 연결이 끊겼어요. 계정을 지우고 다시 연결해 주세요.');
    if(secret.oauth.accessToken&&secret.oauth.expiresAt>now()+60000)return secret.oauth.accessToken;
    const {status,data}=await msPost('/token',{client_id:outlookClientId,grant_type:'refresh_token',refresh_token:secret.oauth.refreshToken,scope:MS_SCOPE});
    if(status!==200||!data.access_token)fail(401,'Outlook 로그인이 만료됐어요. 계정을 지우고 다시 연결해 주세요.');
    await saveSecret(account.id,{oauth:{refreshToken:data.refresh_token||secret.oauth.refreshToken,accessToken:data.access_token,expiresAt:now()+Number(data.expires_in||3600)*1000}});
    return data.access_token;
  }

  // ── 연결 ──
  const accountRow=id=>one(`SELECT * FROM accounts WHERE id = ?`,String(id||''))||fail(404,'메일 계정을 찾을 수 없어요.');
  async function authFor(account,secret){
    if(account.provider==='outlook')return {user:account.username,accessToken:await outlookToken(account)};
    const s=secret||await secretOf(account.id);
    if(!s?.password)fail(401,'저장된 비밀번호가 없어요. 계정 설정에서 비밀번호를 다시 넣어 주세요.');
    return {user:account.username,pass:s.password};
  }
  async function openImap(account,secret){
    const client=await clients.imap({host:account.imap_host,port:account.imap_port,secure:Boolean(account.imap_secure),auth:await authFor(account,secret),tls:{servername:account.imap_host}});
    try{await client.connect();}catch(e){try{client.close?.();}catch{}fail(502,imapError(e));}
    return client;
  }
  async function withImap(account,fn,secret){
    const client=await openImap(account,secret);
    try{return await fn(client);}
    catch(e){if(e instanceof MailError)throw e;fail(502,imapError(e));}
    finally{try{await client.logout();}catch{try{client.close?.();}catch{}}}
  }
  async function smtpFor(account,secret){
    return clients.smtp({host:account.smtp_host,port:account.smtp_port,secure:Boolean(account.smtp_secure),requireTLS:!account.smtp_secure,auth:account.provider==='outlook'?{type:'OAuth2',user:account.username,accessToken:await outlookToken(account)}:await authFor(account,secret),tls:{servername:account.smtp_host}});
  }

  // ── 동기화 ──
  async function syncFolders(account,client){
    const list=(await client.list()).filter(f=>!(f.flags instanceof Set?f.flags.has('\\Noselect'):Array.isArray(f.flags)&&f.flags.includes('\\Noselect')));
    const seen=new Set();
    for(const f of list){
      seen.add(f.path);
      run(`INSERT INTO folders (account_id, path, name, special) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name, special = excluded.special`,account.id,f.path,clean(f.name||f.path,120),specialOf(f));
    }
    for(const f of q(`SELECT path FROM folders WHERE account_id = ?`,account.id))if(!seen.has(f.path)){run(`DELETE FROM folders WHERE account_id = ? AND path = ?`,account.id,f.path);run(`DELETE FROM messages WHERE account_id = ? AND folder = ?`,account.id,f.path);}
  }
  function storeEnvelope(account,folder,msg){
    const env=msg.envelope||{};
    const from=addrList(env.from)[0]||{name:'',address:''};
    const flags=msg.flags instanceof Set?msg.flags:new Set(msg.flags||[]);
    const date=(env.date||msg.internalDate)?new Date(env.date||msg.internalDate).toISOString():iso();
    const r=run(`INSERT INTO messages (account_id, folder, uid, message_id, subject, from_name, from_addr, to_json, cc_json, date, seen, flagged, answered, has_att, size, in_reply_to, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, folder, uid) DO UPDATE SET seen = excluded.seen, flagged = excluded.flagged, answered = excluded.answered`,
      account.id,folder,Number(msg.uid),clean(env.messageId,300)||null,clean(env.subject,500),from.name,from.address,JSON.stringify(addrList(env.to)),JSON.stringify(addrList(env.cc)),date,
      flags.has('\\Seen')?1:0,flags.has('\\Flagged')?1:0,flags.has('\\Answered')?1:0,hasAttachment(msg.bodyStructure)?1:0,Number(msg.size||0)||null,clean(env.inReplyTo,300)||null,iso());
    return r.changes;
  }
  async function syncFolder(account,client,path,{limit=LIST_LIMIT}={}){
    const lock=await client.getMailboxLock(path);
    const fresh=[];
    try{
      const box=client.mailbox||{};
      const validity=String(box.uidValidity??'');
      const stored=one(`SELECT uidvalidity FROM folders WHERE account_id = ? AND path = ?`,account.id,path);
      if(stored?.uidvalidity&&stored.uidvalidity!==validity){run(`DELETE FROM messages WHERE account_id = ? AND folder = ?`,account.id,path);run(`DELETE FROM bodies WHERE account_id = ? AND folder = ?`,account.id,path);}
      const maxUid=Number(one(`SELECT MAX(uid) AS m FROM messages WHERE account_id = ? AND folder = ?`,account.id,path)?.m||0);
      const exists=Number(box.exists||0);
      const fetched=[];
      if(exists>0){
        const query={uid:true,envelope:true,flags:true,bodyStructure:true,size:true,internalDate:true};
        if(!maxUid){for await(const msg of client.fetch(`${Math.max(1,exists-limit+1)}:*`,query))fetched.push(msg);}
        else{for await(const msg of client.fetch(`${maxUid+1}:*`,query,{uid:true}))if(Number(msg.uid)>maxUid)fetched.push(msg);}
        // 이미 받은 메일의 읽음·별표 바뀜과 지워진 메일을 맞춘다(최근 300개)
        if(maxUid){
          const low=Math.max(1,maxUid-300),alive=new Set();
          for await(const msg of client.fetch(`${low}:${maxUid}`,{uid:true,flags:true},{uid:true})){
            alive.add(Number(msg.uid));
            const flags=msg.flags instanceof Set?msg.flags:new Set(msg.flags||[]);
            run(`UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE account_id = ? AND folder = ? AND uid = ?`,flags.has('\\Seen')?1:0,flags.has('\\Flagged')?1:0,flags.has('\\Answered')?1:0,account.id,path,Number(msg.uid));
          }
          for(const r of q(`SELECT uid FROM messages WHERE account_id = ? AND folder = ? AND uid >= ? AND uid <= ?`,account.id,path,low,maxUid))if(!alive.has(r.uid)){run(`DELETE FROM messages WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,path,r.uid);run(`DELETE FROM bodies WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,path,r.uid);}
        }
      }else{run(`DELETE FROM messages WHERE account_id = ? AND folder = ?`,account.id,path);}
      for(const msg of fetched)if(storeEnvelope(account,path,msg)&&maxUid)fresh.push(Number(msg.uid));
      let unseen=0;
      try{unseen=(await client.search({seen:false},{uid:true}))?.length||0;}catch{unseen=Number(one(`SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND folder = ? AND seen = 0`,account.id,path)?.n||0);}
      run(`UPDATE folders SET uidvalidity = ?, total = ?, unseen = ?, synced_at = ? WHERE account_id = ? AND path = ?`,validity,exists,unseen,iso(),account.id,path);
      // 너무 오래된 머리글은 지운다(폴더마다 최근 2,000개만)
      run(`DELETE FROM messages WHERE account_id = ? AND folder = ? AND uid NOT IN (SELECT uid FROM messages WHERE account_id = ? AND folder = ? ORDER BY uid DESC LIMIT 2000)`,account.id,path,account.id,path);
    }finally{lock.release();}
    return fresh;
  }
  const folderBySpecial=(accountId,special)=>one(`SELECT path FROM folders WHERE account_id = ? AND special = ?`,accountId,special)?.path||null;
  async function applyRules(account,client,uids){
    const rules=q(`SELECT * FROM rules WHERE enabled = 1 AND (account_id IS NULL OR account_id = ?)`,account.id);
    if(!rules.length||!uids.length)return 0;
    let applied=0;
    for(const uid of uids){
      const m=one(`SELECT * FROM messages WHERE account_id = ? AND folder = 'INBOX' AND uid = ?`,account.id,uid);
      if(!m)continue;
      for(const rule of rules){
        const hay=(rule.field==='from'?`${m.from_name} ${m.from_addr}`:rule.field==='to'?m.to_json:m.subject||'').toLowerCase();
        if(!hay.includes(rule.contains.toLowerCase()))continue;
        try{
          const lock=await client.getMailboxLock('INBOX');
          try{
            if(rule.action==='read'){await client.messageFlagsAdd(String(uid),['\\Seen'],{uid:true});run(`UPDATE messages SET seen = 1 WHERE account_id = ? AND folder = 'INBOX' AND uid = ?`,account.id,uid);}
            else if(rule.action==='star'){await client.messageFlagsAdd(String(uid),['\\Flagged'],{uid:true});run(`UPDATE messages SET flagged = 1 WHERE account_id = ? AND folder = 'INBOX' AND uid = ?`,account.id,uid);}
            else if(rule.action==='move'&&rule.target){await client.messageMove(String(uid),rule.target,{uid:true});run(`DELETE FROM messages WHERE account_id = ? AND folder = 'INBOX' AND uid = ?`,account.id,uid);}
          }finally{lock.release();}
          applied++;
        }catch{/* 규칙 하나가 실패해도 다음 메일로 */}
        if(rule.action==='move')break;
      }
    }
    return applied;
  }
  const syncing=new Map();
  async function syncAccount(accountId,{folders:extra=[]}={}){
    if(syncing.has(accountId))return syncing.get(accountId);
    const job=(async()=>{
      const account=accountRow(accountId);
      const firstSync=!account.last_sync_at;
      try{
        const result=await withImap(account,async client=>{
          await syncFolders(account,client);
          const targets=[...new Set(['INBOX',folderBySpecial(account.id,'\\Sent'),...extra].filter(Boolean))].filter(p=>one(`SELECT 1 AS x FROM folders WHERE account_id = ? AND path = ?`,account.id,p));
          let fresh=[];
          for(const path of targets){const got=await syncFolder(account,client,path);if(path==='INBOX')fresh=got;}
          if(fresh.length){
            let ruleApplied=0;
            try{ruleApplied=await applyRules(account,client,fresh);}catch{}
            for(const uid of fresh){const m=one(`SELECT subject, from_name, from_addr, date, seen FROM messages WHERE account_id = ? AND folder = 'INBOX' AND uid = ?`,account.id,uid);if(m&&!m.seen)recent.push({id:messageKey(account.id,'INBOX',uid),account:account.address,subject:m.subject||'(제목 없음)',from:m.from_name||m.from_addr,date:m.date,version:version+1});}
            while(recent.length>50)recent.shift();
            version++;
            return {fresh:fresh.length,ruleApplied};
          }
          return {fresh:0,ruleApplied:0};
        });
        run(`UPDATE accounts SET last_sync_at = ?, last_error = NULL WHERE id = ?`,iso(),account.id);
        // 처음 받아 온 메일은 알림을 띄우지 않지만, 화면이 목록을 새로 읽도록 바뀜 번호는 올린다.
        if(firstSync&&!result.fresh)version++;
        return result;
      }catch(error){run(`UPDATE accounts SET last_error = ? WHERE id = ?`,clean(error.message,300),account.id);throw error;}
    })();
    syncing.set(accountId,job);
    try{return await job;}finally{syncing.delete(accountId);}
  }

  // ── 메시지 열쇠: 계정.폴더(base64url).uid ──
  const messageKey=(accountId,folder,uid)=>`${accountId}.${b64url(folder)}.${uid}`;
  function parseKey(key){
    const m=/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{1,400})\.(\d{1,10})$/.exec(String(key||''));
    if(!m)fail(404,'메일을 찾을 수 없어요.');
    const account=accountRow(m[1]);
    return {account,folder:unb64url(m[2]),uid:Number(m[3])};
  }
  function messageView(m,accounts){
    const a=accounts?.get(m.account_id);
    return {id:messageKey(m.account_id,m.folder,m.uid),accountId:m.account_id,account:a?.address||'',accountLabel:a?.label||'',folder:m.folder,uid:m.uid,
      subject:m.subject||'(제목 없음)',from:{name:m.from_name||'',address:m.from_addr||''},to:JSON.parse(m.to_json||'[]'),cc:JSON.parse(m.cc_json||'[]'),date:m.date,
      seen:Boolean(m.seen),flagged:Boolean(m.flagged),answered:Boolean(m.answered),hasAttachment:Boolean(m.has_att),size:m.size,snippet:m.snippet||'',messageId:m.message_id||null};
  }
  const accountView=a=>({id:a.id,provider:a.provider,preset:a.preset,presetLabel:PRESETS[a.preset]?.label||a.preset,address:a.address,name:a.name||'',label:a.label||'',username:a.username,
    imap:{host:a.imap_host,port:a.imap_port,secure:Boolean(a.imap_secure)},smtp:{host:a.smtp_host,port:a.smtp_port,secure:Boolean(a.smtp_secure)},signature:a.signature||'',
    createdAt:a.created_at,lastSyncAt:a.last_sync_at||null,lastError:a.last_error||null,
    unread:Number(one(`SELECT unseen FROM folders WHERE account_id = ? AND path = 'INBOX'`,a.id)?.unseen||0)});

  // ── 본문 ──
  async function fetchBody(account,folder,uid){
    const cached=one(`SELECT * FROM bodies WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,folder,uid);
    if(cached)return cached;
    const source=await withImap(account,async client=>{
      const lock=await client.getMailboxLock(folder);
      try{const msg=await client.fetchOne(String(uid),{source:true},{uid:true});if(!msg?.source)fail(404,'메일이 서버에서 지워졌어요.');return msg.source;}
      finally{lock.release();}
    });
    const parsed=await clients.parse(source);
    const cid={},attachments=[];
    (parsed.attachments||[]).forEach((att,index)=>{
      const contentId=att.contentId||att.cid;
      if(contentId&&/^image\//.test(att.contentType)&&att.size<2*1024*1024){const ref=String(contentId).replace(/^<|>$/g,'');cid[ref]=`data:${att.contentType};base64,${Buffer.from(att.content).toString('base64')}`;}
      if(!(contentId&&att.related))attachments.push({index,name:clean(att.filename||`첨부${index+1}`,200),mime:clean(att.contentType||'application/octet-stream',100),size:Number(att.size||att.content?.length||0)});
    });
    const rawHtml=typeof parsed.html==='string'&&parsed.html?parsed.html:null;
    const safe=rawHtml?sanitizeHtml(rawHtml,{cid}).html:textToHtml(parsed.text||'');
    const text=clean(parsed.text||stripHtml(rawHtml),200000);
    run(`INSERT OR REPLACE INTO bodies (account_id, folder, uid, html, text, raw_html, attachments, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,account.id,folder,uid,safe,text,rawHtml,JSON.stringify(attachments),iso());
    run(`UPDATE messages SET snippet = ?, refs = ? WHERE account_id = ? AND folder = ? AND uid = ?`,clean(text.replace(/\s+/g,' '),160),clean(Array.isArray(parsed.references)?parsed.references.join(' '):parsed.references||'',2000)||null,account.id,folder,uid);
    // 캐시는 최근 2,000통까지
    run(`DELETE FROM bodies WHERE rowid NOT IN (SELECT rowid FROM bodies ORDER BY fetched_at DESC LIMIT ${BODY_CACHE})`);
    return one(`SELECT * FROM bodies WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,folder,uid);
  }
  // 「이미지 보기」: 원격 이미지를 이 PC 가 받아 data: 로 넣는다(화면은 바깥 주소를 직접 열지 못한다). 사설·내부 주소는 받지 않는다.
  async function inlineRemoteImages(html){
    const urls=[...new Set([...String(html).matchAll(/\ssrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi)].map(m=>m[1]))].slice(0,30);
    const map=new Map();
    await Promise.all(urls.map(async u=>{
      try{
        const url=new URL(u.replace(/&amp;/g,'&'));
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;
        const addrs=await resolveHost(url.hostname,{all:true});
        if(!addrs.length||addrs.some(a=>privateAddress(a.address)))return;
        const res=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
        const type=(res.headers.get('content-type')||'').split(';')[0];
        if(!res.ok||!/^image\/(png|jpe?g|gif|webp|bmp)$/.test(type))return;
        const buf=Buffer.from(await res.arrayBuffer());
        if(buf.length>2*1024*1024)return;
        map.set(u,`data:${type};base64,${buf.toString('base64')}`);
      }catch{}
    }));
    return String(html).replace(/(\ssrc\s*=\s*["'])(https?:\/\/[^"']+)(["'])/gi,(m,a,u,c)=>map.has(u)?a+map.get(u)+c:'');
  }

  // ── 보내기 ──
  async function compose(account,input){
    const to=parseAddresses(input.to,'받는 사람'),cc=parseAddresses(input.cc,'참조'),bcc=parseAddresses(input.bcc,'숨은 참조');
    if(!to.length&&!cc.length&&!bcc.length)fail(400,'받는 사람을 넣어 주세요.');
    const subject=clean(input.subject,300);
    let text=String(input.text??'').slice(0,200000);
    if(account.signature&&input.signature!==false)text+=`\n\n--\n${account.signature}`;
    const attachments=(Array.isArray(input.attachments)?input.attachments:[]).slice(0,20).map(a=>({filename:clean(a?.name,200)||'첨부',contentType:clean(a?.mime,100)||'application/octet-stream',content:Buffer.from(String(a?.base64||''),'base64')}));
    if(attachments.reduce((s,a)=>s+a.content.length,0)>MAX_ATTACH_SEND)fail(413,'첨부 파일은 합쳐서 15MB까지 보낼 수 있어요.');
    const message={from:{name:account.name||'',address:account.address},to,cc,bcc,subject,text,attachments,date:new Date(now())};
    if(input.html)message.html=sanitizeHtml(String(input.html).slice(0,500000)).html;
    if(input.inReplyTo){
      const {account:origAccount,folder,uid}=parseKey(input.inReplyTo);
      const orig=one(`SELECT message_id, refs FROM messages WHERE account_id = ? AND folder = ? AND uid = ?`,origAccount.id,folder,uid);
      if(orig?.message_id){message.inReplyTo=orig.message_id;message.references=[...(orig.refs||'').split(/\s+/).filter(Boolean),orig.message_id].slice(-20).join(' ');}
    }
    return clients.compose(message);
  }
  async function deliver(account,input){
    const built=await compose(account,input);
    const transport=await smtpFor(account);
    try{await transport.sendMail({envelope:built.envelope,raw:built.raw});}
    catch(e){fail(502,'메일을 보내지 못했어요: '+imapError(e));}
    finally{transport.close?.();}
    const preset=PRESETS[account.preset];
    if(account.save_sent&&preset?.saveSent!==false){
      const sent=folderBySpecial(account.id,'\\Sent');
      if(sent)try{await withImap(account,client=>client.append(sent,built.raw,['\\Seen']));}catch{/* 보낸메일함 저장 실패는 보내기 성공을 되돌리지 않는다 */}
    }
    if(input.inReplyTo){
      try{const {account:a,folder,uid}=parseKey(input.inReplyTo);await withImap(a,async client=>{const lock=await client.getMailboxLock(folder);try{await client.messageFlagsAdd(String(uid),['\\Answered'],{uid:true});}finally{lock.release();}});run(`UPDATE messages SET answered = 1 WHERE account_id = ? AND folder = ? AND uid = ?`,a.id,folder,uid);}catch{}
    }
    return {messageId:built.messageId};
  }
  let outboxBusy=false;
  async function runOutbox(){
    if(outboxBusy)return 0;outboxBusy=true;let sent=0;
    try{
      for(const job of q(`SELECT * FROM outbox WHERE status = 'queued' AND send_at <= ? ORDER BY send_at LIMIT 10`,iso())){
        try{
          run(`UPDATE outbox SET status = 'sending' WHERE id = ?`,job.id);
          await deliver(accountRow(job.account_id),JSON.parse(job.payload));
          run(`UPDATE outbox SET status = 'sent', sent_at = ?, payload = '{}' WHERE id = ?`,iso(),job.id);sent++;
        }catch(error){run(`UPDATE outbox SET status = 'failed', error = ? WHERE id = ?`,clean(error.message,300),job.id);}
      }
    }finally{outboxBusy=false;}
    return sent;
  }

  // ── AI(라피스 대화로 요약·답장 초안·할 일/일정 뽑기) ──
  async function askLapis(message){
    const result=await cloud.call('POST','/chat',{body:{message:message.slice(0,12000),origin:'mail'}});
    if(result.status===402){const d=JSON.parse(result.text||'{}');fail(402,d.error||'AI 사용 한도를 넘었어요.');}
    if(result.status<200||result.status>=300)fail(502,'라피스가 지금 답하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
    const data=JSON.parse(result.text||'{}');
    if(typeof data.response!=='string')fail(502,'라피스 응답을 읽지 못했어요.');
    return data.response.trim();
  }
  const mailForAi=(m,body)=>`보낸 사람: ${m.from_name||''} <${m.from_addr||''}>\n받은 시각: ${m.date}\n제목: ${m.subject||'(제목 없음)'}\n\n${clean(body.text||stripHtml(body.html),6000)}`;

  // ── 감시(IDLE): 새 메일이 오면 곧바로 받은편지함을 맞춘다 ──
  const watchers=new Map();
  let timers=[];
  function scheduleSync(accountId){
    const w=watchers.get(accountId);if(!w)return;
    clearTimeout(w.debounce);
    w.debounce=setTimeout(()=>{syncAccount(accountId).catch(()=>{});},2500);
  }
  async function watchAccount(accountId){
    if(!watch||watchers.has(accountId))return;
    const w={stopped:false,client:null,backoff:5000,debounce:null};
    watchers.set(accountId,w);
    const loop=async()=>{
      while(!w.stopped){
        try{
          const account=one(`SELECT * FROM accounts WHERE id = ?`,accountId);
          if(!account){w.stopped=true;break;}
          w.client=await openImap(account);
          w.backoff=5000;
          await w.client.mailboxOpen('INBOX');
          w.client.on('exists',()=>scheduleSync(accountId));
          w.client.on('flags',()=>scheduleSync(accountId));
          await new Promise(resolve=>{w.client.on('close',resolve);w.client.on('error',resolve);});
        }catch{/* 연결 실패는 아래에서 기다렸다가 다시 */}
        if(w.stopped)break;
        await new Promise(r=>setTimeout(r,w.backoff));
        w.backoff=Math.min(w.backoff*2,5*60000);
      }
    };
    loop();
  }
  function unwatch(accountId){const w=watchers.get(accountId);if(!w)return;w.stopped=true;clearTimeout(w.debounce);try{w.client?.close?.();}catch{}watchers.delete(accountId);}
  function start(){
    if(!watch)return;
    // 연결한 계정이 없으면 DB 파일도 만들지 않는다(계정을 처음 연결하면 그때부터 감시한다).
    if(hasDb())for(const a of q(`SELECT id FROM accounts`))watchAccount(a.id);
    // IDLE 을 못 쓰는 서버를 위해 5분마다 한 번 더 맞추고, 예약 메일은 30초마다 확인한다.
    timers.push(setInterval(()=>{if(hasDb())for(const a of q(`SELECT id FROM accounts`))syncAccount(a.id).catch(()=>{});},5*60000));
    timers.push(setInterval(()=>{if(hasDb())runOutbox().catch(()=>{});},30000));
    for(const t of timers)t.unref?.();
    setTimeout(()=>{if(hasDb())for(const a of q(`SELECT id FROM accounts`))syncAccount(a.id).catch(()=>{});},3000).unref?.();
  }
  function stop(){for(const id of [...watchers.keys()])unwatch(id);for(const t of timers)clearInterval(t);timers=[];try{opened?.close();}catch{}opened=null;}

  return {
    start,stop,runOutbox,
    presets:()=>Object.keys(PRESETS),
    async accounts(){await gate('gw.mail',{readOnly:true});return q(`SELECT * FROM accounts ORDER BY sort, created_at`).map(accountView);},
    async addAccount(input){
      const presetId=PRESETS[input.preset]?input.preset:presetFor(input.address);
      const preset=PRESETS[presetId];
      if(preset.oauth)fail(400,'Outlook 은 「Microsoft 로 연결」을 눌러 주세요.');
      const address=clean(input.address,254).toLowerCase();
      if(!EMAIL.test(address))fail(400,'메일 주소가 올바르지 않아요.');
      if(one(`SELECT 1 AS x FROM accounts WHERE address = ?`,address))fail(409,'이미 연결한 메일 주소예요.');
      const password=String(input.password||'');
      if(!password||password.length>512)fail(400,'비밀번호(앱 비밀번호)를 넣어 주세요.');
      const imap={host:clean(input.imap?.host||preset.imap.host,200),port:Number(input.imap?.port||preset.imap.port),secure:input.imap?.secure===undefined?preset.imap.secure:input.imap.secure!==false};
      const smtp={host:clean(input.smtp?.host||preset.smtp.host,200),port:Number(input.smtp?.port||preset.smtp.port),secure:input.smtp?.secure===undefined?preset.smtp.secure:input.smtp.secure!==false};
      for(const [label,s] of [['IMAP',imap],['SMTP',smtp]]){
        if(!/^[A-Za-z0-9.-]{3,200}$/.test(s.host))fail(400,`${label} 서버 주소를 넣어 주세요.`);
        if(!Number.isInteger(s.port)||s.port<1||s.port>65535)fail(400,`${label} 포트가 올바르지 않아요.`);
      }
      await gate('gw.mail',{count:1});
      const account={id:randomUUID(),provider:'imap',preset:presetId,address,name:clean(input.name,80),label:clean(input.label,40),username:clean(input.username||address,254),
        imap_host:imap.host,imap_port:imap.port,imap_secure:imap.secure?1:0,smtp_host:smtp.host,smtp_port:smtp.port,smtp_secure:smtp.secure?1:0,save_sent:preset.saveSent===false?0:1};
      // 저장하기 전에 실제로 로그인해 본다(IMAP 받기, SMTP 보내기 둘 다)
      const secret={password};
      await withImap(account,async client=>{await client.list();},secret);
      const transport=await smtpFor(account,secret);
      try{await transport.verify();}catch(e){fail(502,'받기(IMAP)는 되지만 보내기(SMTP) 로그인에 실패했어요: '+imapError(e));}finally{transport.close?.();}
      await reportAccount({...account});
      await saveSecret(account.id,secret);
      run(`INSERT INTO accounts (id, provider, preset, address, name, label, username, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, save_sent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        account.id,account.provider,account.preset,account.address,account.name||null,account.label||null,account.username,account.imap_host,account.imap_port,account.imap_secure,account.smtp_host,account.smtp_port,account.smtp_secure,account.save_sent,iso());
      syncAccount(account.id).catch(()=>{});
      watchAccount(account.id);
      return accountView(accountRow(account.id));
    },
    async updateAccount(id,input){
      const a=accountRow(id);
      const label=input.label===undefined?a.label:clean(input.label,40),name=input.name===undefined?a.name:clean(input.name,80),signature=input.signature===undefined?a.signature:String(input.signature||'').slice(0,2000);
      if(input.password){
        if(a.provider!=='imap')fail(400,'이 계정은 비밀번호를 쓰지 않아요.');
        await withImap(a,client=>client.list(),{password:String(input.password)});
        await saveSecret(a.id,{password:String(input.password)});
      }
      run(`UPDATE accounts SET label = ?, name = ?, signature = ?, last_error = CASE WHEN ? THEN NULL ELSE last_error END WHERE id = ?`,label||null,name||null,signature||null,input.password?1:0,a.id);
      await reportAccount({...a,label});
      return accountView(accountRow(a.id));
    },
    async removeAccount(id){
      const a=accountRow(id);
      unwatch(a.id);
      for(const t of ['messages','bodies','folders'])run(`DELETE FROM ${t} WHERE account_id = ?`,a.id);
      run(`DELETE FROM outbox WHERE account_id = ? AND status = 'queued'`,a.id);
      run(`DELETE FROM accounts WHERE id = ?`,a.id);
      await saveSecret(a.id,null);
      await reportAccount(a,{remove:true}).catch(()=>{});
      return {ok:true};
    },
    async sync(id,folder){return syncAccount(accountRow(id).id,{folders:folder?[folder]:[]});},
    async outlookStart(){
      if(!outlookClientId)fail(501,'Outlook 연결에는 Microsoft 앱 등록(클라이언트 ID)이 필요해요. config.local.json 의 outlookClientId 를 채운 뒤 다시 시도해 주세요. 그 전에는 IMAP 을 켠 회사 메일이면 「직접 입력」으로 연결할 수 있어요.',{code:'OUTLOOK_NOT_CONFIGURED'});
      await gate('gw.mail',{count:1});
      const {status,data}=await msPost('/devicecode',{client_id:outlookClientId,scope:MS_SCOPE});
      if(status!==200||!data.device_code)fail(502,'Microsoft 로그인을 시작하지 못했어요.');
      const attemptId=randomUUID();
      outlookAttempts.set(attemptId,{deviceCode:data.device_code,expiresAt:now()+Number(data.expires_in||900)*1000});
      return {attemptId,userCode:data.user_code,verificationUri:data.verification_uri,expiresAt:new Date(now()+Number(data.expires_in||900)*1000).toISOString(),interval:Number(data.interval||5)};
    },
    async outlookPoll(attemptId,{label,name}={}){
      const attempt=outlookAttempts.get(String(attemptId||''));
      if(!attempt||attempt.expiresAt<now())fail(404,'로그인 요청이 만료됐어요. 처음부터 다시 해 주세요.');
      const {status,data}=await msPost('/token',{client_id:outlookClientId,grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:attempt.deviceCode});
      if(data.error==='authorization_pending'||data.error==='slow_down')return {status:'pending'};
      if(status!==200||!data.access_token||!data.refresh_token){outlookAttempts.delete(attemptId);fail(400,'Microsoft 로그인이 취소됐거나 실패했어요.');}
      outlookAttempts.delete(attemptId);
      let claims={};try{claims=JSON.parse(Buffer.from(String(data.id_token||'').split('.')[1]||'','base64url').toString('utf8'));}catch{}
      const address=clean(claims.email||claims.preferred_username,254).toLowerCase();
      if(!EMAIL.test(address))fail(502,'Microsoft 계정의 메일 주소를 확인하지 못했어요.');
      if(one(`SELECT 1 AS x FROM accounts WHERE address = ?`,address))fail(409,'이미 연결한 메일 주소예요.');
      const p=PRESETS.outlook;
      const account={id:randomUUID(),provider:'outlook',preset:'outlook',address,label:clean(label,40)};
      await reportAccount(account);
      await saveSecret(account.id,{oauth:{refreshToken:data.refresh_token,accessToken:data.access_token,expiresAt:now()+Number(data.expires_in||3600)*1000}});
      run(`INSERT INTO accounts (id, provider, preset, address, name, label, username, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, save_sent, created_at) VALUES (?, 'outlook', 'outlook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        account.id,address,clean(name||claims.name,80)||null,account.label||null,address,p.imap.host,p.imap.port,1,p.smtp.host,p.smtp.port,0,iso());
      syncAccount(account.id).catch(()=>{});watchAccount(account.id);
      return {status:'completed',account:accountView(accountRow(account.id))};
    },
    async folders(accountId){
      await gate('gw.mail',{readOnly:true});
      const a=accountRow(accountId);
      return q(`SELECT * FROM folders WHERE account_id = ? ORDER BY CASE special WHEN '\\Inbox' THEN 0 WHEN '\\Sent' THEN 1 WHEN '\\Drafts' THEN 2 WHEN '\\Archive' THEN 3 WHEN '\\Junk' THEN 4 WHEN '\\Trash' THEN 5 ELSE 9 END, name`,a.id)
        .map(f=>({path:f.path,name:f.path==='INBOX'?'받은편지함':f.name,special:f.special,total:f.total,unseen:f.unseen,syncedAt:f.synced_at}));
    },
    async messages({account='all',folder='INBOX',q:query='',before='',limit=50,unread=false,flagged=false}={}){
      await gate('gw.mail',{readOnly:true});
      const accounts=new Map(q(`SELECT * FROM accounts`).map(a=>[a.id,a]));
      const where=[],args=[];
      if(account==='all'){where.push(`m.folder = 'INBOX'`);}
      else{accountRow(account);where.push('m.account_id = ?','m.folder = ?');args.push(account,folder);}
      if(query){const like='%'+clean(query,80).replace(/[\\%_]/g,c=>'\\'+c)+'%';where.push(`(m.subject LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\' OR m.from_addr LIKE ? ESCAPE '\\' OR m.snippet LIKE ? ESCAPE '\\' OR m.to_json LIKE ? ESCAPE '\\')`);args.push(like,like,like,like,like);}
      if(unread)where.push('m.seen = 0');
      if(flagged)where.push('m.flagged = 1');
      if(before){where.push('m.date < ?');args.push(String(before));}
      const n=Math.min(Math.max(Number(limit)||50,1),200);
      const list=q(`SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT ?`,...args,n+1);
      return {messages:list.slice(0,n).map(m=>messageView(m,accounts)),hasMore:list.length>n};
    },
    async message(key,{remote=false}={}){
      await gate('gw.mail',{readOnly:true});
      const {account,folder,uid}=parseKey(key);
      const m=one(`SELECT * FROM messages WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,folder,uid)||fail(404,'메일을 찾을 수 없어요.');
      const body=await fetchBody(account,folder,uid);
      let html=body.html,blockedRemote=0;
      if(body.raw_html){
        const cidOnly=sanitizeHtml(body.raw_html,{cid:{}});blockedRemote=cidOnly.blockedRemote;
        if(remote){html=await inlineRemoteImages(sanitizeHtml(body.raw_html,{allowRemote:true}).html);blockedRemote=0;}
      }
      if(!m.seen){
        try{await withImap(account,async client=>{const lock=await client.getMailboxLock(folder);try{await client.messageFlagsAdd(String(uid),['\\Seen'],{uid:true});}finally{lock.release();}});run(`UPDATE messages SET seen = 1 WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,folder,uid);run(`UPDATE folders SET unseen = MAX(0, unseen - 1) WHERE account_id = ? AND path = ?`,account.id,folder);}catch{}
      }
      const accounts=new Map([[account.id,account]]);
      return {message:{...messageView({...one(`SELECT * FROM messages WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,folder,uid)},accounts),html,text:body.text||'',attachments:JSON.parse(body.attachments||'[]'),blockedRemote}};
    },
    async attachment(key,index){
      await gate('gw.mail',{readOnly:true});
      const {account,folder,uid}=parseKey(key);
      const source=await withImap(account,async client=>{const lock=await client.getMailboxLock(folder);try{return (await client.fetchOne(String(uid),{source:true},{uid:true}))?.source;}finally{lock.release();}});
      if(!source)fail(404,'메일이 서버에서 지워졌어요.');
      const att=(await clients.parse(source)).attachments?.[Number(index)];
      if(!att)fail(404,'첨부 파일을 찾을 수 없어요.');
      const content=Buffer.from(att.content);
      if(content.length>MAX_ATTACH_READ)fail(413,'5MB 가 넘는 첨부는 메일 서비스 웹사이트에서 받아 주세요.');
      return {name:clean(att.filename||'첨부',200),mime:att.contentType||'application/octet-stream',size:content.length,base64:content.toString('base64')};
    },
    async flags(key,{seen,flagged}){
      const {account,folder,uid}=parseKey(key);
      await withImap(account,async client=>{
        const lock=await client.getMailboxLock(folder);
        try{
          if(seen===true)await client.messageFlagsAdd(String(uid),['\\Seen'],{uid:true});if(seen===false)await client.messageFlagsRemove(String(uid),['\\Seen'],{uid:true});
          if(flagged===true)await client.messageFlagsAdd(String(uid),['\\Flagged'],{uid:true});if(flagged===false)await client.messageFlagsRemove(String(uid),['\\Flagged'],{uid:true});
        }finally{lock.release();}
      });
      if(typeof seen==='boolean')run(`UPDATE messages SET seen = ? WHERE account_id = ? AND folder = ? AND uid = ?`,seen?1:0,account.id,folder,uid);
      if(typeof flagged==='boolean')run(`UPDATE messages SET flagged = ? WHERE account_id = ? AND folder = ? AND uid = ?`,flagged?1:0,account.id,folder,uid);
      return {ok:true};
    },
    async move(key,to){
      const {account,folder,uid}=parseKey(key);
      const target=to==='trash'?folderBySpecial(account.id,'\\Trash'):to==='archive'?folderBySpecial(account.id,'\\Archive'):to==='inbox'?'INBOX':to==='junk'?folderBySpecial(account.id,'\\Junk'):one(`SELECT path FROM folders WHERE account_id = ? AND path = ?`,account.id,String(to||''))?.path;
      if(!target)fail(400,to==='archive'?'이 메일 계정에는 보관함이 없어요.':'옮길 편지함을 찾을 수 없어요.');
      if(target===folder)return {ok:true};
      await withImap(account,async client=>{const lock=await client.getMailboxLock(folder);try{await client.messageMove(String(uid),target,{uid:true});}finally{lock.release();}});
      run(`DELETE FROM messages WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,folder,uid);
      run(`DELETE FROM bodies WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,folder,uid);
      version++;
      return {ok:true,folder:target};
    },
    async send(input){
      if(input?.confirm!==true)fail(400,'보내기 전에 화면에서 한 번 더 확인해 주세요.');
      await gate('gw.mail');
      const account=accountRow(input.accountId);
      if(input.sendAt){
        await gate('gw.mail.rules');
        const at=Date.parse(input.sendAt);
        if(Number.isNaN(at)||at<now()+60000)fail(400,'예약 시각은 1분 뒤부터 고를 수 있어요.');
        if(at>now()+90*86400000)fail(400,'예약은 90일 안으로만 할 수 있어요.');
        await compose(account,input);   // 주소·첨부를 지금 검사한다
        const jobId=randomUUID();
        run(`INSERT INTO outbox (id, account_id, payload, send_at, created_at) VALUES (?, ?, ?, ?, ?)`,jobId,account.id,JSON.stringify({...input,sendAt:undefined}),new Date(at).toISOString(),iso());
        return {scheduled:true,id:jobId,sendAt:new Date(at).toISOString()};
      }
      const result=await deliver(account,input);
      return {sent:true,...result};
    },
    async outbox(){return q(`SELECT id, account_id, payload, send_at, status, error, created_at, sent_at FROM outbox WHERE status != 'sent' OR sent_at > ? ORDER BY send_at DESC LIMIT 100`,new Date(now()-7*86400000).toISOString()).map(o=>{const p=JSON.parse(o.payload||'{}');return {id:o.id,accountId:o.account_id,subject:clean(p.subject,200),to:Array.isArray(p.to)?p.to.join(', '):clean(p.to,300),sendAt:o.send_at,status:o.status,error:o.error||null,sentAt:o.sent_at||null};});},
    async cancelOutbox(id){const r=run(`DELETE FROM outbox WHERE id = ? AND status IN ('queued','failed')`,String(id||''));if(!r.changes)fail(404,'취소할 예약 메일이 없어요.');return {ok:true};},
    async rules(){return q(`SELECT * FROM rules ORDER BY created_at`).map(r=>({id:r.id,accountId:r.account_id||null,field:r.field,contains:r.contains,action:r.action,target:r.target||null,enabled:Boolean(r.enabled)}));},
    async addRule(input){
      await gate('gw.mail.rules');
      const field=['from','subject','to'].includes(input.field)?input.field:fail(400,'조건 항목이 올바르지 않아요.');
      const action=['read','star','move'].includes(input.action)?input.action:fail(400,'동작이 올바르지 않아요.');
      const contains=clean(input.contains,100);if(!contains)fail(400,'찾을 말을 넣어 주세요.');
      let accountId=null;if(input.accountId){accountId=accountRow(input.accountId).id;}
      const target=action==='move'?clean(input.target,300):null;
      if(action==='move'&&(!accountId||!one(`SELECT 1 AS x FROM folders WHERE account_id = ? AND path = ?`,accountId,target)))fail(400,'옮길 편지함을 골라 주세요(계정을 먼저 고르면 편지함이 보여요).');
      if(q(`SELECT id FROM rules`).length>=50)fail(429,'규칙은 50개까지 만들 수 있어요.');
      const ruleId=randomUUID();
      run(`INSERT INTO rules (id, account_id, field, contains, action, target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,ruleId,accountId,field,contains,action,target,iso());
      return {id:ruleId};
    },
    async removeRule(id){run(`DELETE FROM rules WHERE id = ?`,String(id||''));return {ok:true};},
    async ai(key,{action,instruction=''}){
      await gate('gw.mail.ai');
      const {account,folder,uid}=parseKey(key);
      const m=one(`SELECT * FROM messages WHERE account_id = ? AND folder = ? AND uid = ?`,account.id,folder,uid)||fail(404,'메일을 찾을 수 없어요.');
      const body=await fetchBody(account,folder,uid);
      const mail=mailForAi(m,body);
      if(action==='summary')return {text:await askLapis(`아래 이메일을 한국어로 3줄 이내로 요약해 주세요. 받는 사람이 해야 할 일이 있으면 마지막에 「할 일:」 아래 짧은 목록으로 적어 주세요. 요약 외의 말은 쓰지 마세요.\n\n${mail}`)};
      if(action==='reply')return {text:await askLapis(`아래 이메일에 보낼 정중한 한국어 답장 초안을 써 주세요. 인사, 본문, 맺음말만 쓰고 제목·설명·따옴표는 쓰지 마세요.${instruction?` 답장에 담을 내용: ${clean(instruction,500)}`:''}\n\n${mail}`)};
      if(action==='extract'){
        const today=new Date(now()+9*3600000).toISOString().slice(0,10);
        const raw=await askLapis(`오늘은 ${today}(한국 시각)입니다. 아래 이메일에서 받는 사람이 해야 할 일과 약속(회의·마감·행사)을 뽑아 JSON 하나만 출력하세요. 형식: {"tasks":[{"title":"...","due":"YYYY-MM-DD 또는 null"}],"events":[{"title":"...","date":"YYYY-MM-DD","start":"HH:MM 또는 null","end":"HH:MM 또는 null","location":"... 또는 빈 문자열"}]}. 없으면 빈 배열. JSON 밖의 글은 쓰지 마세요.\n\n${mail}`);
        let parsed={tasks:[],events:[]};
        try{parsed=JSON.parse(raw.slice(raw.indexOf('{'),raw.lastIndexOf('}')+1));}catch{}
        const day=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?String(v):null,time=v=>/^\d{2}:\d{2}$/.test(String(v||''))?String(v):null;
        return {tasks:(Array.isArray(parsed.tasks)?parsed.tasks:[]).slice(0,10).map(t=>({title:clean(t?.title,200),due:day(t?.due)})).filter(t=>t.title),
          events:(Array.isArray(parsed.events)?parsed.events:[]).slice(0,10).map(e=>({title:clean(e?.title,200),date:day(e?.date),start:time(e?.start),end:time(e?.end),location:clean(e?.location,200)})).filter(e=>e.title&&e.date),
          source:{subject:m.subject||'',from:m.from_name||m.from_addr||''}};
      }
      fail(400,'AI 기능 종류가 올바르지 않아요.');
    },
    async briefing({force=false}={}){
      await gate('gw.mail.ai');
      const cached=one(`SELECT value, at FROM meta WHERE key = 'briefing'`);
      if(cached&&!force&&now()-cached.at<30*60000)return JSON.parse(cached.value);
      const since=new Date(now()-24*3600000).toISOString();
      const list=q(`SELECT m.subject, m.from_name, m.from_addr, m.date, a.address FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.folder = 'INBOX' AND m.seen = 0 AND m.date >= ? ORDER BY m.date DESC LIMIT 25`,since);
      if(!list.length){const out={text:'지난 하루 동안 읽지 않은 새 메일이 없어요.',count:0,at:iso()};run(`INSERT OR REPLACE INTO meta (key, value, at) VALUES ('briefing', ?, ?)`,JSON.stringify(out),now());return out;}
      const text=await askLapis(`아래는 지난 하루 동안 받은, 아직 읽지 않은 메일 목록입니다(제목·보낸 사람만). 업무상 먼저 봐야 할 것을 3개 이내로 골라 한국어 한두 줄씩 알려 주고, 광고·알림성 메일은 「그 밖에 n통」으로만 묶어 주세요.\n\n${list.map((m,i)=>`${i+1}. [${m.address}] ${m.from_name||m.from_addr}: ${m.subject||'(제목 없음)'}`).join('\n')}`);
      const out={text,count:list.length,at:iso()};
      run(`INSERT OR REPLACE INTO meta (key, value, at) VALUES ('briefing', ?, ?)`,JSON.stringify(out),now());
      return out;
    },
    async summary(){
      if(!hasDb())return {accounts:0,unread:0,version,recent:[],errors:[]};
      const accounts=q(`SELECT * FROM accounts ORDER BY sort, created_at`);
      const unread=accounts.reduce((s,a)=>s+Number(one(`SELECT unseen FROM folders WHERE account_id = ? AND path = 'INBOX'`,a.id)?.unseen||0),0);
      return {accounts:accounts.length,unread,version,recent:recent.slice(-10),errors:accounts.filter(a=>a.last_error).map(a=>({accountId:a.id,address:a.address,error:a.last_error}))};
    },
    async contacts(query){
      const like='%'+clean(query,60).replace(/[\\%_]/g,c=>'\\'+c)+'%';
      const rows=q(`SELECT from_name AS name, from_addr AS address, MAX(date) AS last FROM messages WHERE from_addr LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\' GROUP BY from_addr ORDER BY last DESC LIMIT 15`,like,like);
      return rows.filter(r=>r.address).map(r=>({name:r.name||'',address:r.address}));
    },
    entitlements,
    get _db(){return db();},
  };
}
