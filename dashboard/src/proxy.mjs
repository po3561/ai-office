import { randomBytes } from 'node:crypto';
export class RequestError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
export async function readLimited(stream,limit) {
  let total=0; const chunks=[];
  for await (const chunk of stream) {
    total+=chunk.length;
    if(total>limit)throw new RequestError(413,'파일 또는 응답이 허용 크기를 넘었습니다.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function upstream(url,{method='GET',body,headers={},timeout=15000,limit=20*1024*1024}={}) {
  try {
    const response=await fetch(url,{method,body,headers,redirect:'manual',signal:AbortSignal.timeout(timeout)});
    if(response.status>=300&&response.status<400){
      await response.body?.cancel();
      throw new RequestError(502,'연결 서비스에서 다른 주소로 이동을 요청했습니다. 로그인을 확인하세요.');
    }
    const bytes=response.body?await readLimited(response.body,limit):Buffer.alloc(0);
    return {status:response.status,headers:response.headers,bytes};
  }catch(e){
    if(e instanceof RequestError)throw e;
    throw new RequestError(503,'연결 서비스가 응답하지 않습니다. 실행 상태와 네트워크를 확인하세요.');
  }
}
export class RentalSessions {
  #sessions=new Map();
  get(header=''){
    const id=/(?:^|;\s*)lapis_rental=([a-f0-9]{48})(?:;|$)/.exec(header)?.[1];
    const session=this.#sessions.get(id);
    if(session&&session.until>Date.now())return {id,...session};
    if(id)this.#sessions.delete(id);
    return null;
  }
  login(upstreamCookie){
    const adm=/(?:^|,\s*)adm=([^;]*)/.exec(upstreamCookie||'')?.[1];
    if(!adm)throw new RequestError(502,'창고 로그인 세션을 확인하지 못했습니다.');
    for(const [id,s] of this.#sessions)if(s.until<=Date.now())this.#sessions.delete(id);
    if(this.#sessions.size>=256)throw new RequestError(503,'로그인 세션이 많습니다. 대시보드를 다시 시작해 주세요.');
    const id=randomBytes(24).toString('hex');
    this.#sessions.set(id,{cookie:'adm='+adm,until:Date.now()+12*3600*1000});
    return 'lapis_rental='+id+'; HttpOnly; SameSite=Strict; Path=/rental; Max-Age=43200';
  }
  logout(id){if(id)this.#sessions.delete(id);return 'lapis_rental=; HttpOnly; SameSite=Strict; Path=/rental; Max-Age=0';}
}
