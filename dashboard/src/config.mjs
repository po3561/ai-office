// 개인 주소·봇 이름처럼 저장소에 올리면 안 되는 값은 config.local.json(깃에 올라가지 않음)에서 읽는다.
// 예시는 config.example.json 을 복사해 config.local.json 으로 만들어 채운다.
import {readFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let cached;
export function localConfig(){
  if(cached)return cached;
  try{cached=JSON.parse(readFileSync(process.env.LAPIS_CONFIG||join(ROOT,'config.local.json'),'utf8'))||{};}
  catch{cached={};}
  return cached;
}
// 설정이 없을 때 쓰는 값은 비워 둔다(연결 기능만 꺼진 것으로 안내한다).
export const rentalUrl=()=>String(localConfig().rentalUrl||'').replace(/\/$/,'');
export const cloudBase=()=>String(localConfig().cloudBase||'').replace(/\/$/,'');
export const botUsername=id=>String(localConfig().botUsernames?.[id]||'');
