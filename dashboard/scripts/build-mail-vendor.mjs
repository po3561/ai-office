// 메일 브리지의 외부 라이브러리(imapflow·nodemailer·mailparser)를 src/mail/vendor.mjs 한 파일로 묶는다.
// 실행본(4310)은 npm 의존성이 없어서, 라이브러리를 이렇게 묶어 싣는다.
//
// 쓰는 법(라이브러리는 임시 폴더에 받는다 — 이 폴더에 node_modules 를 만들지 않는다):
//   mkdir <임시>; cd <임시>; npm init -y; npm install imapflow@1.7.8 nodemailer@6.10.1 mailparser@3.9.38 esbuild@0.25
//   node scripts/build-mail-vendor.mjs <임시>
import {writeFileSync,readdirSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const deps=resolve(process.argv[2]||'');
if(!existsSync(join(deps,'node_modules','imapflow')))throw new Error('라이브러리를 받은 폴더를 알려 주세요: node scripts/build-mail-vendor.mjs <폴더>');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(deps,'package.json'));
const esbuild=require('esbuild');
const version=p=>JSON.parse(readFileSync(join(deps,'node_modules',p,'package.json'),'utf8')).version;
const entry=join(deps,'lapis-mail-entry.cjs');
writeFileSync(entry,`const {ImapFlow}=require('imapflow');const nodemailer=require('nodemailer');const {simpleParser}=require('mailparser');module.exports={ImapFlow,nodemailer,simpleParser};\n`);
await esbuild.build({entryPoints:[entry],bundle:true,minify:true,platform:'node',target:'node22',format:'esm',legalComments:'none',
  outfile:join(root,'src','mail','vendor.mjs'),
  banner:{js:`import {createRequire as __lapisRequire} from 'node:module';const require=__lapisRequire(import.meta.url); // imapflow ${version('imapflow')} (MIT) · nodemailer ${version('nodemailer')} (MIT-0) · mailparser ${version('mailparser')} (MIT). 직접 고치지 말고 scripts/build-mail-vendor.mjs 로 다시 만든다. 라이선스: VENDOR-LICENSES.txt`}});
let notice='LAPIS 메일 브리지(src/mail/vendor.mjs)에 묶인 오픈소스 라이선스\n\n';
const dirs=[];
for(const d of readdirSync(join(deps,'node_modules'))){if(d.startsWith('.')||d==='esbuild'||d==='@esbuild')continue;if(d.startsWith('@'))for(const s of readdirSync(join(deps,'node_modules',d)))dirs.push(d+'/'+s);else dirs.push(d);}
for(const d of dirs){
  const dir=join(deps,'node_modules',d);
  let pkg;try{pkg=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));}catch{continue;}
  const lic=readdirSync(dir).find(f=>/^licen[cs]e/i.test(f));
  notice+=`==== ${d} ${pkg.version} (${pkg.license||'?'})\n${lic?readFileSync(join(dir,lic),'utf8'):'(라이선스 파일 없음 — package.json: '+(pkg.license||'?')+')'}\n\n`;
}
writeFileSync(join(root,'src','mail','VENDOR-LICENSES.txt'),notice);
console.log('vendor.mjs + VENDOR-LICENSES.txt ('+dirs.length+' packages)');
