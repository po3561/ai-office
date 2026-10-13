// 메일 브리지 시험. 실제 IMAP·SMTP 프로토콜로 확인한다(시험용 서버 hoodiecrow-imap·smtp-server).
// 시험용 서버 패키지는 실행본에 싣지 않으므로, 설치한 폴더를 MAIL_TEST_DEPS 로 알려 줘야 한다.
//   MAIL_TEST_DEPS=<node_modules 가 있는 폴더> node --test tests/mail.test.mjs
// 없으면 프로토콜 시험은 건너뛰고 본문 안전 처리 시험만 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {sanitizeHtml} from '../src/mail/sanitize.mjs';
import {createMailService,defaultClients} from '../src/mail/service.mjs';
import {createVault,plain} from '../src/vault.mjs';

test('본문 안전 처리: 스크립트·이벤트·위험 주소를 걷고, 원격 이미지는 막고, cid 는 data: 로',()=>{
  const {html,blockedRemote}=sanitizeHtml(`<p onclick="x()">안녕</p><script>alert(1)</script><img src="https://tracker.test/p.gif"><img src="cid:logo@x"><a href="javascript:alert(1)">a</a><iframe src="https://e.test"></iframe><form action="https://e.test"><input name=a></form><style>@import url(https://e.test/a.css);.a{background:url(https://e.test/b.png)}</style><div style="background:url('http://e.test/c.png')">x</div><svg><script>1</script></svg>`,{cid:{'logo@x':'data:image/png;base64,AAAA'}});
  assert.doesNotMatch(html,/<script|onclick|javascript:|<iframe|<form|<input|@import|<svg/i);
  assert.doesNotMatch(html,/tracker\.test|e\.test\/b\.png|e\.test\/c\.png/);
  assert.match(html,/data:image\/png;base64,AAAA/);
  assert.equal(blockedRemote,1);
  assert.match(sanitizeHtml('<img src="https://a.test/x.png">',{allowRemote:true}).html,/https:\/\/a\.test\/x\.png/);
});

const depsDir=process.env.MAIL_TEST_DEPS;
const deps=depsDir?createRequire(join(depsDir,'package.json')):null;
const skip=!deps&&'MAIL_TEST_DEPS 가 없어 실제 프로토콜 시험은 건너뜀';

function rawMail({from='=?UTF-8?B?7YyA7J6l?= <boss@corp.test>',to='me@corp.test',subject,body,html,date='Tue, 13 Oct 2026 09:00:00 +0900',id}){
  const enc=s=>'=?UTF-8?B?'+Buffer.from(s).toString('base64')+'?=';
  if(!html)return `From: ${from}\r\nTo: ${to}\r\nSubject: ${enc(subject)}\r\nDate: ${date}\r\nMessage-ID: <${id}@corp.test>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body).toString('base64')}\r\n`;
  const b='BOUNDARY42';
  return `From: ${from}\r\nTo: ${to}\r\nSubject: ${enc(subject)}\r\nDate: ${date}\r\nMessage-ID: <${id}@corp.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${b}"\r\n\r\n--${b}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString('base64')}\r\n--${b}\r\nContent-Type: image/png\r\nContent-ID: <logo@corp>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--${b}\r\nContent-Type: application/pdf; name="견적서.pdf"\r\nContent-Disposition: attachment; filename="=?UTF-8?B?${Buffer.from('견적서.pdf').toString('base64')}?="\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('%PDF-1.4 test').toString('base64')}\r\n--${b}--\r\n`;
}

async function harness({paywall='off',mailUsed=0,mailLimit=1,aiAllowed=true}={}){
  const hoodiecrow=deps('hoodiecrow-imap'),{SMTPServer}=deps('smtp-server');
  const imap=hoodiecrow({plugins:['ID','IDLE','UIDPLUS','SPECIAL-USE','MOVE','ENABLE','UNSELECT','LITERALPLUS'],
    storage:{
      INBOX:{messages:[
        {raw:rawMail({subject:'주간 회의 안내',body:'내일 10시 회의입니다. 자료 준비 부탁드립니다.',id:'m1'}),flags:[],internaldate:'13-Oct-2026 09:00:00 +0900'},
        {raw:rawMail({subject:'견적서 송부',html:'<p onclick="x()">견적서를 보냅니다</p><img src="cid:logo@corp"><img src="https://tracker.test/p.gif"><script>alert(1)</script>',id:'m2',date:'Tue, 13 Oct 2026 10:00:00 +0900'}),flags:['\\Seen'],internaldate:'13-Oct-2026 10:00:00 +0900'},
      ]},
      '':{separator:'/',folders:{
        Sent:{'special-use':'\\Sent',messages:[]},
        Trash:{'special-use':'\\Trash',messages:[]},
        Projects:{messages:[]},
      }},
    },
    users:{'me@corp.test':{password:'app-pass-1234'}}});
  await new Promise(r=>imap.listen(0,'127.0.0.1',r));
  const received=[];
  const smtp=new SMTPServer({authOptional:false,disabledCommands:['STARTTLS'],onAuth(auth,session,cb){cb(auth.username==='me@corp.test'&&auth.password==='app-pass-1234'?null:new Error('bad'),{user:'me'});},
    onData(stream,session,cb){const chunks=[];stream.on('data',c=>chunks.push(c));stream.on('end',()=>{received.push({to:session.envelope.rcptTo.map(r=>r.address),raw:Buffer.concat(chunks).toString('utf8')});cb();});}});
  await new Promise(r=>smtp.listen(0,'127.0.0.1',r));
  const dataDir=mkdtempSync(join(tmpdir(),'lapis-mail-'));
  const vault=createVault(join(dataDir,'vault.bin'),plain);
  const chats=[],meta=[];
  let clock=Date.parse('2026-10-13T01:00:00Z');
  const cloud={async call(method,path,{body}={}){
    if(path==='/lapis/entitlements')return {status:200,text:JSON.stringify({paywall,features:{'gw.mail':{label:'메일 연결',allowed:true,limit:mailLimit,used:mailUsed+meta.filter(m=>m.method==='POST').length,requiredPlan:'free'},'gw.mail.ai':{label:'메일 AI',allowed:aiAllowed,requiredPlan:'basic',reason:'메일 AI 는 베이직 요금제부터 쓸 수 있어요.'},'gw.mail.rules':{allowed:true}}})};
    if(path.startsWith('/lapis/gw/mail/accounts')){meta.push({method,path,body});return {status:200,text:'{"ok":true}'};}
    if(path==='/chat'){chats.push(body.message);return {status:200,text:JSON.stringify({response:body.message.includes('JSON')?'{"tasks":[{"title":"회의 자료 준비","due":"2026-10-14"}],"events":[{"title":"주간 회의","date":"2026-10-14","start":"10:00","end":null,"location":""}]}':'내일 10시 회의, 자료 준비 필요.'})};}
    return {status:404,text:'{}'};
  }};
  // 시험용 서버는 TLS 가 없어 평문으로 붙는다(실제 서비스는 프리셋대로 TLS).
  const clients={...defaultClients,smtp:o=>defaultClients.smtp({...o,secure:false,requireTLS:false,ignoreTLS:true}),imap:o=>defaultClients.imap({...o,secure:false,doSTARTTLS:false})};
  const service=createMailService({dataDir,vault,cloud,clients,now:()=>clock,watch:false});
  const account={preset:'custom',address:'me@corp.test',password:'app-pass-1234',name:'나',imap:{host:'127.0.0.1',port:imap.server.address().port,secure:false},smtp:{host:'127.0.0.1',port:smtp.server.address().port,secure:false}};
  return {imap,smtp,service,vault,dataDir,received,chats,meta,account,tick:ms=>{clock+=ms;},
    async close(){service.stop();await new Promise(r=>smtp.close(r));await new Promise(r=>imap.close?imap.close(r):imap.server.close(r));}};
}

test('계정 연결: 틀린 비밀번호는 한국어로 알려 주고, 맞으면 저장한다(비밀번호는 금고에만)',{skip},async()=>{
  const h=await harness();
  try{
    await assert.rejects(h.service.addAccount({...h.account,password:'wrong'}),e=>e.status===502&&/비밀번호/.test(e.message));
    const account=await h.service.addAccount(h.account);
    assert.equal(account.address,'me@corp.test');
    assert.equal(h.meta.filter(m=>m.method==='POST').length,1);
    assert.ok(!JSON.stringify(h.meta).includes('app-pass-1234'),'클라우드로 비밀번호가 가지 않는다');
    assert.equal((await h.vault.read()).mailSecrets[account.id].password,'app-pass-1234');
    for(const f of readdirSync(join(h.dataDir,'mail')))assert.ok(!readFileSync(join(h.dataDir,'mail',f)).includes('app-pass-1234'),'메일 캐시에 비밀번호가 없다: '+f);
    await assert.rejects(h.service.addAccount(h.account),e=>e.status===409);
  }finally{await h.close();}
});

test('동기화·읽기: 머리글, 안전한 본문, cid 이미지, 첨부, 읽음 표시가 서버에도 반영',{skip},async()=>{
  const h=await harness();
  try{
    const {id}=await h.service.addAccount(h.account);
    await h.service.sync(id);
    const list=await h.service.messages({account:'all'});
    assert.deepEqual(list.messages.map(m=>m.subject),['견적서 송부','주간 회의 안내']);
    const meeting=list.messages[1];
    assert.equal(meeting.seen,false);assert.equal(meeting.from.name,'팀장');
    assert.equal((await h.service.accounts())[0].unread,1);
    const quote=(await h.service.message(list.messages[0].id)).message;
    assert.doesNotMatch(quote.html,/<script|onclick|tracker\.test/);
    assert.match(quote.html,/data:image\/png;base64/);
    assert.equal(quote.blockedRemote,1);
    assert.deepEqual(quote.attachments.map(a=>a.name),['견적서.pdf']);
    const att=await h.service.attachment(list.messages[0].id,quote.attachments[0].index);
    assert.equal(Buffer.from(att.base64,'base64').toString(),'%PDF-1.4 test');
    await h.service.message(meeting.id);
    await h.service.sync(id);
    assert.equal((await h.service.messages({account:'all',unread:true})).messages.length,0,'열어 본 메일은 서버에서도 읽음');
    const folders=await h.service.folders(id);
    assert.equal(folders[0].name,'받은편지함');assert.ok(folders.some(f=>f.special==='\\Sent'));
    assert.deepEqual((await h.service.contacts('boss')).map(c=>c.address),['boss@corp.test']);
  }finally{await h.close();}
});

test('별표·휴지통 이동, 보내기(확인 필수)·보낸편지함 저장·답장 표시',{skip},async()=>{
  const h=await harness();
  try{
    const {id}=await h.service.addAccount(h.account);
    await h.service.sync(id);
    let list=(await h.service.messages({account:'all'})).messages;
    await h.service.flags(list[0].id,{flagged:true});
    assert.equal((await h.service.messages({account:'all',flagged:true})).messages.length,1);
    await assert.rejects(h.service.send({accountId:id,to:'a@b.test',subject:'x',text:'y'}),e=>e.status===400);
    await assert.rejects(h.service.send({accountId:id,to:'잘못된주소',subject:'x',text:'y',confirm:true}),e=>e.status===400&&/주소/.test(e.message));
    const meeting=list.find(m=>m.subject==='주간 회의 안내');
    const sent=await h.service.send({accountId:id,to:['팀장 <boss@corp.test>'],cc:'cc@corp.test',subject:'Re: 주간 회의 안내',text:'참석하겠습니다.',inReplyTo:meeting.id,confirm:true,attachments:[{name:'메모.txt',mime:'text/plain',base64:Buffer.from('메모').toString('base64')}]});
    assert.ok(sent.sent);
    assert.equal(h.received.length,1);
    assert.deepEqual(h.received[0].to.sort(),['boss@corp.test','cc@corp.test']);
    assert.match(h.received[0].raw,/In-Reply-To: <m1@corp\.test>/);
    await h.service.sync(id,'Sent');
    const sentFolder=(await h.service.messages({account:id,folder:'Sent'})).messages;
    assert.equal(sentFolder.length,1,'보낸편지함에 저장');
    await h.service.sync(id);
    list=(await h.service.messages({account:'all'})).messages;
    assert.equal(list.find(m=>m.subject==='주간 회의 안내').answered,true);
    await h.service.move(list[0].id,'trash');
    await h.service.sync(id,'Trash');
    assert.equal((await h.service.messages({account:id,folder:'Trash'})).messages.length,1);
    assert.equal((await h.service.messages({account:'all'})).messages.length,1);
  }finally{await h.close();}
});

test('새 메일 동기화·자동 분류 규칙·예약 발송',{skip},async()=>{
  const h=await harness();
  try{
    const {id}=await h.service.addAccount(h.account);
    await h.service.sync(id);
    await h.service.addRule({accountId:id,field:'subject',contains:'광고',action:'move',target:'Projects'});
    await h.service.addRule({field:'from',contains:'boss@corp.test',action:'star'});
    // 서버에 새 메일 두 통이 들어온다
    const {ImapFlow}=(await import('../src/mail/vendor.mjs')).default;
    const c=new ImapFlow({host:'127.0.0.1',port:h.imap.server.address().port,secure:false,doSTARTTLS:false,auth:{user:'me@corp.test',pass:'app-pass-1234'},logger:false});
    await c.connect();
    await c.append('INBOX',rawMail({subject:'[광고] 할인',body:'광고',id:'m3',from:'ad@shop.test'}));
    await c.append('INBOX',rawMail({subject:'급한 확인',body:'오늘 중 확인 부탁',id:'m4'}));
    await c.logout();
    const result=await h.service.sync(id);
    assert.equal(result.fresh,2);
    const inbox=(await h.service.messages({account:'all'})).messages;
    assert.ok(!inbox.some(m=>m.subject.includes('광고')),'광고는 Projects 로 옮겨졌다');
    assert.equal(inbox.find(m=>m.subject==='급한 확인').flagged,true);
    const summary=await h.service.summary();
    assert.ok(summary.recent.some(r=>r.subject==='급한 확인'));
    // 예약 발송: 1분 이상 뒤만, 시간이 되면 보낸다
    await assert.rejects(h.service.send({accountId:id,to:'x@corp.test',subject:'예약',text:'본문',confirm:true,sendAt:new Date(Date.parse('2026-10-13T01:00:10Z')).toISOString()}),e=>e.status===400);
    const job=await h.service.send({accountId:id,to:'x@corp.test',subject:'예약',text:'본문',confirm:true,sendAt:'2026-10-13T02:00:00Z'});
    assert.ok(job.scheduled);
    assert.equal(await h.service.runOutbox(),0);
    h.tick(2*3600000);
    assert.equal(await h.service.runOutbox(),1);
    assert.equal(h.received.length,1);
    assert.equal((await h.service.outbox())[0].status,'sent');
  }finally{await h.close();}
});

test('AI 요약·할 일/일정 뽑기, 요금제 잠금(402)과 계정 수 한도',{skip},async()=>{
  const h=await harness({paywall:'on',aiAllowed:false});
  try{
    const {id}=await h.service.addAccount(h.account);
    await h.service.sync(id);
    const m=(await h.service.messages({account:'all'})).messages.find(x=>x.subject==='주간 회의 안내');
    await assert.rejects(h.service.ai(m.id,{action:'summary'}),e=>e.status===402&&e.extra.code==='FEATURE_LOCKED'&&e.extra.requiredPlan==='basic');
    await assert.rejects(h.service.addAccount({...h.account,address:'two@corp.test'}),e=>e.status===402,'무료 1개 한도');
  }finally{await h.close();}
  const h2=await harness();
  try{
    const {id}=await h2.service.addAccount(h2.account);
    await h2.service.sync(id);
    const m=(await h2.service.messages({account:'all'})).messages.find(x=>x.subject==='주간 회의 안내');
    assert.equal((await h2.service.ai(m.id,{action:'summary'})).text,'내일 10시 회의, 자료 준비 필요.');
    assert.match(h2.chats[0],/내일 10시 회의입니다/);
    const ex=await h2.service.ai(m.id,{action:'extract'});
    assert.deepEqual(ex.tasks,[{title:'회의 자료 준비',due:'2026-10-14'}]);
    assert.equal(ex.events[0].start,'10:00');
    const brief=await h2.service.briefing();
    assert.ok(brief.count>=1);
    await h2.service.removeAccount(id);
    assert.equal((await h2.vault.read()).mailSecrets[id],undefined,'계정을 지우면 비밀번호도 지운다');
    assert.ok(h2.meta.some(x=>x.method==='DELETE'));
  }finally{await h2.close();}
});
