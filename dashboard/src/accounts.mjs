// 계정별 저장소: 로그인한 라피스 계정마다 할 일·일정·Google 연결 정보를 따로 보관한다.
//   <데이터>/accounts/<계정ID>/{tasks.json, calendar.json, vault.bin}
// PC 전체에 하나뿐인 vault(vault.bin)에는 "누가 로그인했는지"(클라우드 세션)만 남는다.
// 이 기능이 생기기 전에 쓰던 자료(할 일·일정·Google 설정)는 처음 로그인하는 계정이 한 번만 이어받는다.
import {join} from 'node:path';
import {mkdir,copyFile,rename,access,writeFile} from 'node:fs/promises';
import {CloudError} from './lapis-cloud.mjs';

const ID=/^[A-Za-z0-9_-]{1,64}$/;   // 서버가 주는 계정 ID(UUID). 경로에 쓰므로 모양을 엄격히 확인한다.
const exists=async file=>{try{await access(file);return true;}catch{return false;}};

export function createAccounts({dataDir,cloud,pcVault,createVault,createTaskStore,createCalendarStore}){
  const cache=new Map();
  let claim=null;   // 옛 자료 이어받기는 한 번에 하나만

  async function claimLegacy(userId,dir,accountVault){
    const marker=join(dataDir,'legacy-claimed.json');
    if(await exists(marker))return;
    if(claim)return claim;
    claim=(async()=>{
      for(const name of ['tasks.json','calendar.json']){
        const from=join(dataDir,name);
        if(await exists(from)&&!await exists(join(dir,name))){await copyFile(from,join(dir,name));await rename(from,from+'.claimed');}
      }
      const pc=await pcVault.read();
      if(pc.gcal){await accountVault.update({gcal:pc.gcal});await pcVault.update({gcal:undefined});}
      await writeFile(marker,JSON.stringify({by:userId,at:new Date().toISOString()}));
    })();
    try{await claim;}finally{claim=null;}
  }

  async function forUser(userId){
    if(!ID.test(String(userId)))throw new CloudError(400,'계정 정보가 올바르지 않습니다. 다시 로그인해 주세요.');
    let scope=cache.get(userId);
    if(!scope){
      const dir=join(dataDir,'accounts',userId);
      await mkdir(dir,{recursive:true});
      const vault=createVault(join(dir,'vault.bin'));
      await claimLegacy(userId,dir,vault);
      scope={dir,vault,tasks:createTaskStore(join(dir,'tasks.json')),calendar:createCalendarStore(join(dir,'calendar.json'))};
      cache.set(userId,scope);
    }
    return scope;
  }
  async function current(){
    const state=await cloud.state();
    if(!state.signedIn)throw new CloudError(401,'로그인이 필요해요.');
    return forUser(state.user.id);
  }
  // 저장소 객체처럼 쓰되, 부를 때마다 "지금 로그인한 계정"의 저장소로 연결한다.
  const proxy=key=>new Proxy({},{get:(_,name)=>typeof name==='symbol'||name==='then'?undefined:(...args)=>current().then(scope=>scope[key][name](...args))});
  return {current,forUser,tasks:proxy('tasks'),calendar:proxy('calendar'),vault:proxy('vault'),forget:()=>cache.clear()};
}
