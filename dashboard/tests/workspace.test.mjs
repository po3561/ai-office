import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceStore,validateLink,progress,TEMPLATES} from '../web/workspace-model.js';

test('saved resources accept genuine service URLs and reject deceptive or executable links',()=>{
  assert.equal(validateLink('https://docs.google.com/spreadsheets/d/demo/edit').service,'sheets');
  assert.equal(validateLink('https://docs.google.com/forms/d/demo/edit').service,'forms');
  assert.equal(validateLink('https://youtu.be/example').service,'youtube');
  for(const url of ['javascript:alert(1)','http://drive.google.com/','https://drive.google.com.evil.test/','https://evil.test/?url=https://drive.google.com','https://owner:password'+'@drive.google.com/'])assert.throws(()=>validateLink(url));
});
test('failed persistence preserves last saved state; reload retains successful edits',()=>{
  let raw=null,fail=false;
  const storage={getItem:()=>raw,setItem:(k,v)=>{if(fail)throw new Error('full');raw=v;}};
  const store=createWorkspaceStore(storage);
  store.save({...store.value,tasks:[{id:'t1',title:'확인할 업무',done:false}]});
  fail=true;
  assert.throws(()=>store.save({...store.value,tasks:[]}));
  assert.equal(store.value.tasks.length,1);
  assert.equal(createWorkspaceStore(storage).value.tasks[0].title,'확인할 업무');
});
test('malformed stored data is preserved instead of overwritten, and flow completion is bounded',()=>{
  let writes=0;
  const store=createWorkspaceStore({getItem:()=>'{broken',setItem:()=>writes++});
  assert.ok(store.error);
  assert.throws(()=>store.save(store.value));
  assert.equal(writes,0);
  const template=TEMPLATES[0];
  assert.equal(progress({template:template.id,completed:[0,0,999,-1]}),Math.round(100/template.steps.length));
  assert.equal(progress({template:'unknown',completed:[0]}),0);
});

test('a stale tab cannot overwrite work saved by another tab before its storage event',()=>{
  let raw=null;
  const storage={getItem:()=>raw,setItem:(k,v)=>{raw=v;}};
  const first=createWorkspaceStore(storage),second=createWorkspaceStore(storage);
  first.save({...first.value,tasks:[{id:'other-tab',title:'먼저 저장한 업무',done:false}]});
  assert.throws(()=>second.save({...second.value,note:'다른 탭의 메모'}),/다른 탭/);
  assert.equal(JSON.parse(raw).tasks[0].id,'other-tab');
  assert.equal(second.value.tasks[0].id,'other-tab');
  second.save({...second.value,note:'다시 저장한 메모'});
  assert.equal(JSON.parse(raw).tasks.length,1);
  assert.equal(JSON.parse(raw).note,'다시 저장한 메모');
});
