// /api/mail/* — 에디터(본체 local-bridge)와 같은 계정의 웹 에디터만 부른다(공통 검사는 server.mjs 가 먼저 한다).
import {MailError} from './service.mjs';
import {publicPresets} from './presets.mjs';
import {readLimited,RequestError} from '../proxy.mjs';

const KEY='[0-9a-f-]{36}\\.[A-Za-z0-9_-]{1,400}\\.\\d{1,10}';
async function readBig(req,limit){
  const buffer=await readLimited(req,limit);
  try{return JSON.parse(buffer.toString('utf8')||'{}');}catch{throw new RequestError(400,'요청 형식이 올바르지 않습니다.');}
}
export function createMailRoutes({service}){
  return async function handle(req,res,url,{json,readJson}){
    const path=url.pathname,method=req.method;
    if(!path.startsWith('/api/mail/'))return false;
    const p=url.searchParams;
    try{
      const send=(status,data)=>{json(res,status,data);return true;};
      if(method==='GET'&&path==='/api/mail/presets')return send(200,{presets:publicPresets()});
      if(method==='GET'&&path==='/api/mail/summary')return send(200,await service.summary());
      if(method==='GET'&&path==='/api/mail/accounts')return send(200,{accounts:await service.accounts()});
      if(method==='POST'&&path==='/api/mail/accounts')return send(201,{account:await service.addAccount(await readJson(req))});
      let m=/^\/api\/mail\/accounts\/([0-9a-f-]{36})$/.exec(path);
      if(m&&method==='PATCH')return send(200,{account:await service.updateAccount(m[1],await readJson(req))});
      if(m&&method==='DELETE')return send(200,await service.removeAccount(m[1]));
      m=/^\/api\/mail\/accounts\/([0-9a-f-]{36})\/sync$/.exec(path);
      if(m&&method==='POST'){const b=await readJson(req);return send(200,await service.sync(m[1],typeof b.folder==='string'?b.folder:null));}
      m=/^\/api\/mail\/accounts\/([0-9a-f-]{36})\/folders$/.exec(path);
      if(m&&method==='GET')return send(200,{folders:await service.folders(m[1])});
      if(method==='POST'&&path==='/api/mail/outlook/start')return send(200,await service.outlookStart());
      if(method==='POST'&&path==='/api/mail/outlook/poll'){const b=await readJson(req);return send(200,await service.outlookPoll(b.attemptId,b));}
      if(method==='GET'&&path==='/api/mail/messages')return send(200,await service.messages({account:p.get('account')||'all',folder:p.get('folder')||'INBOX',q:p.get('q')||'',before:p.get('before')||'',limit:p.get('limit')||50,unread:p.get('unread')==='1',flagged:p.get('flagged')==='1'}));
      m=new RegExp(`^/api/mail/messages/(${KEY})$`).exec(path);
      if(m&&method==='GET')return send(200,await service.message(m[1],{remote:p.get('remote')==='1'}));
      m=new RegExp(`^/api/mail/messages/(${KEY})/attachments/(\\d{1,3})$`).exec(path);
      if(m&&method==='GET')return send(200,{attachment:await service.attachment(m[1],m[2])});
      m=new RegExp(`^/api/mail/messages/(${KEY})/(flags|move|ai)$`).exec(path);
      if(m&&method==='POST'){
        const b=await readJson(req);
        if(m[2]==='flags')return send(200,await service.flags(m[1],{seen:typeof b.seen==='boolean'?b.seen:undefined,flagged:typeof b.flagged==='boolean'?b.flagged:undefined}));
        if(m[2]==='move')return send(200,await service.move(m[1],b.to));
        return send(200,await service.ai(m[1],{action:b.action,instruction:typeof b.instruction==='string'?b.instruction:''}));
      }
      if(method==='POST'&&path==='/api/mail/send')return send(200,await service.send(await readBig(req,22*1024*1024)));
      if(method==='GET'&&path==='/api/mail/outbox')return send(200,{outbox:await service.outbox()});
      m=/^\/api\/mail\/outbox\/([0-9a-f-]{36})$/.exec(path);
      if(m&&method==='DELETE')return send(200,await service.cancelOutbox(m[1]));
      if(method==='GET'&&path==='/api/mail/rules')return send(200,{rules:await service.rules()});
      if(method==='POST'&&path==='/api/mail/rules')return send(201,await service.addRule(await readJson(req)));
      m=/^\/api\/mail\/rules\/([0-9a-f-]{36})$/.exec(path);
      if(m&&method==='DELETE')return send(200,await service.removeRule(m[1]));
      if(method==='GET'&&path==='/api/mail/briefing')return send(200,await service.briefing({force:p.get('force')==='1'}));
      if(method==='GET'&&path==='/api/mail/contacts')return send(200,{contacts:await service.contacts(p.get('q')||'')});
      return send(404,{error:'알 수 없는 메일 기능입니다.'});
    }catch(error){
      if(error instanceof MailError){json(res,error.status,{error:error.message,...(error.extra||{})});return true;}
      if(error instanceof RequestError)throw error;
      console.error('mail route error',error?.message);
      json(res,500,{error:'메일 처리 중 오류가 났어요.'});return true;
    }
  };
}
