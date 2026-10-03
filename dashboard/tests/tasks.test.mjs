import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTaskStore,cleanTask} from '../src/tasks.mjs';
import {createDashboardServer} from '../src/server.mjs';

test('할 일 검사: 맡은 사람·마감일 형식', () => {
  assert.equal(cleanTask({title:' 보고서 '}).title,'보고서');
  assert.equal(cleanTask({title:'x',owner:'office:ai-office:researcher'}).owner,'office:ai-office:researcher');
  for(const bad of [{title:''},{title:'x',due:'2026-13-40x'},{title:'x',owner:'office:../x'},{title:'x',owner:'someone'}])
    assert.throws(()=>cleanTask(bad));
});

test('할 일 저장소: 만들기·끝내기·되열기·지우기·끝난 일 정리', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lapis-tasks-'));
  const store=createTaskStore(join(dir,'tasks.json'));
  const a=await store.create({title:'A',due:'2026-10-03'});
  const b=await store.create({title:'B',owner:'lapis'});
  const done=await store.update(a.id,{done:true});
  assert.ok(done.doneAt);
  const reopened=await store.update(a.id,{done:false});
  assert.equal(reopened.doneAt,null);
  await store.update(b.id,{done:true});
  assert.deepEqual(await store.clearDone(),{removed:1});
  await store.remove(a.id);
  assert.deepEqual(await store.list(),[]);
  await assert.rejects(store.remove(a.id),/찾을 수 없습니다/);
  const saved=JSON.parse(await readFile(join(dir,'tasks.json'),'utf8'));
  assert.equal(saved.version,1);
});

test('할 일 저장소: 깨진 파일은 덮어쓰지 않는다', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lapis-tasks-'));
  const file=join(dir,'tasks.json');
  await writeFile(file,'{not json');
  const store=createTaskStore(file);
  await assert.rejects(store.create({title:'x'}),/읽지 못했습니다/);
  assert.equal(await readFile(file,'utf8'),'{not json');
});

test('서버: /api/tasks 는 쓰기 표시가 있어야 바뀐다', async () => {
  const dir=await mkdtemp(join(tmpdir(),'lapis-tasks-'));
  const server=createDashboardServer({dataDir:dir,officeUrl:'http://127.0.0.1:9',rentalUrl:'http://127.0.0.1:9',cloudBase:'https://cloud.test/api/v1'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const denied=await fetch(base+'/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'x'})});
    assert.equal(denied.status,403);
    const made=await fetch(base+'/api/tasks',{method:'POST',headers:{'content-type':'application/json','x-lapis-request':'1'},body:JSON.stringify({title:'회의 준비',due:'2026-10-04'})});
    assert.equal(made.status,201);
    const {task}=await made.json();
    const list=await (await fetch(base+'/api/tasks')).json();
    assert.equal(list.tasks.length,1);
    const patched=await fetch(base+'/api/tasks/'+task.id,{method:'PATCH',headers:{'content-type':'application/json','x-lapis-request':'1'},body:JSON.stringify({done:true})});
    assert.equal((await patched.json()).task.done,true);
    const bad=await fetch(base+'/api/tasks',{method:'POST',headers:{'content-type':'application/json','x-lapis-request':'1'},body:JSON.stringify({title:''})});
    assert.equal(bad.status,400);
  }finally{server.close();}
});
