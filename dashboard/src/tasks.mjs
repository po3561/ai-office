// 할 일: 이 PC 의 파일에 저장한다. 누가 맡았는지(나·라피스·사무실 부서)와 마감일을 함께 둔다.
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

export class TaskError extends Error{constructor(status,message){super(message);this.status=status;}}
const bad=message=>{throw new TaskError(400,message);};
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const MAX=500;

export function cleanTask(input,previous={}){
  const value={...previous,...input};
  const title=String(value.title??'').trim();
  if(!title||title.length>200)bad('할 일을 1~200자로 입력해 주세요.');
  const due=value.due==null||value.due===''?null:String(value.due);
  if(due!==null&&(!DAY.test(due)||Number.isNaN(Date.parse(due+'T00:00:00Z'))))bad('마감일 형식이 올바르지 않습니다.');
  const owner=String(value.owner??'me');
  if(!/^(me|lapis|office:[A-Za-z0-9_.-]{1,64}(:[A-Za-z0-9_.-]{1,64})?)$/.test(owner))bad('맡은 사람이 올바르지 않습니다.');
  const notes=String(value.notes??'');if(notes.length>2000)bad('메모는 2,000자까지 입력할 수 있습니다.');
  const priority=value.priority===true;
  return {title,due,owner,notes,priority,done:value.done===true};
}

export function createTaskStore(file){
  let data=null,queue=Promise.resolve();
  async function load(){
    if(data)return data;
    try{
      const parsed=JSON.parse(await readFile(file,'utf8'));
      if(parsed?.version!==1||!Array.isArray(parsed.tasks))throw new Error('format');
      data=parsed;
    }catch(error){
      if(error?.code==='ENOENT')data={version:1,tasks:[]};
      else throw new TaskError(500,'저장된 할 일을 읽지 못했습니다. 원본 파일을 보호하기 위해 저장을 중지했습니다: '+file);
    }
    return data;
  }
  async function save(){
    await mkdir(dirname(file),{recursive:true});
    const temp=file+'.'+process.pid+'.tmp';
    await writeFile(temp,JSON.stringify(data,null,1));await rename(temp,file);
  }
  const exclusive=fn=>{const run=queue.then(fn);queue=run.catch(()=>undefined);return run;};
  const find=(id)=>{const task=data.tasks.find(t=>t.id===id);if(!task)throw new TaskError(404,'할 일을 찾을 수 없습니다.');return task;};
  return {
    async list(){const d=await load();return structuredClone(d.tasks);},
    create:input=>exclusive(async()=>{
      const d=await load();
      if(d.tasks.length>=MAX)bad('할 일은 최대 '+MAX+'개까지 둘 수 있습니다. 끝난 일을 정리해 주세요.');
      const now=new Date().toISOString();
      const task={id:randomUUID(),...cleanTask(input),createdAt:now,updatedAt:now,doneAt:null};
      d.tasks.push(task);await save();return structuredClone(task);
    }),
    update:(id,patch)=>exclusive(async()=>{
      await load();const task=find(id);
      const next=cleanTask(patch,task);
      const now=new Date().toISOString();
      Object.assign(task,next,{updatedAt:now,doneAt:next.done?(task.doneAt||now):null});
      await save();return structuredClone(task);
    }),
    remove:id=>exclusive(async()=>{
      const d=await load();find(id);
      d.tasks=d.tasks.filter(t=>t.id!==id);await save();return {removed:id};
    }),
    // 계정 동기화: 클라우드에서 받은 할 일로 통째로 바꾼다. 잘못된 항목은 건너뛴다.
    replaceAll:list=>exclusive(async()=>{
      const d=await load();
      if(!Array.isArray(list))bad('할 일 자료가 올바르지 않습니다.');
      const now=new Date().toISOString(),stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:now;
      const next=[];
      for(const t of list.slice(0,MAX)){
        try{
          const c=cleanTask(t);
          next.push({id:/^[0-9a-f-]{36}$/i.test(String(t?.id))?t.id:randomUUID(),...c,createdAt:stamp(t?.createdAt),updatedAt:stamp(t?.updatedAt),doneAt:c.done?stamp(t?.doneAt):null});
        }catch{ /* 형식이 틀린 항목은 건너뛴다 */ }
      }
      d.tasks=next;await save();return {count:next.length};
    }),
    clearDone:()=>exclusive(async()=>{
      const d=await load();const before=d.tasks.length;
      d.tasks=d.tasks.filter(t=>!t.done);await save();return {removed:before-d.tasks.length};
    }),
  };
}
