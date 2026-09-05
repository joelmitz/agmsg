import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {forbiddenTool} from '../scripts/drivers/types/antigravity/antigravity-bridge.mjs';
const repo=path.resolve(import.meta.dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
// 並列時は各fixtureが複数のbash/node子プロセスを生成するため、15秒では
// 正常なNEEDS_ATTENTION到達をtimeoutと誤判定しうる。上限を60秒にする。
async function waitFor(fn){for(let i=0;i<600;i++){if(fn())return;await delay(100);}throw Error('待機timeout');}
function fixture(driver='sqlite',mode='success') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agmsg-agy-test-'));
  const install=path.join(dir,'install'),project=path.join(dir,'project');
  fs.mkdirSync(install);fs.mkdirSync(project);
  fs.cpSync(path.join(repo,'scripts'),path.join(install,'scripts'),{recursive:true});
  fs.copyFileSync(path.join(repo,'tests/fixtures/fake-antigravity.mjs'),path.join(dir,'fake.mjs'));
  const fake=path.join(dir,'agy');fs.writeFileSync(fake,`#!/bin/sh\nexec '${process.execPath}' '${dir}/fake.mjs' "$@"\n`,{mode:0o700});
  const env={...process.env,AGMSG_STORAGE_DRIVER:driver,AGMSG_STORAGE_PATH:path.join(install,'db'),AGMSG_CONFIG:path.join(dir,'config.json'),FAKE_AGY_MODE:mode,FIXTURE_INSTALL:install};
  const sh=(name,args=[])=>{const r=spawnSync('bash',[path.join(install,'scripts',name),...args],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr+r.stdout);return r.stdout;};
  sh('join.sh',['fixture','worker','antigravity',project]);
  sh('join.sh',['fixture','sender','codex',project]);
  sh('delivery.sh',['set','monitor','antigravity',project]);
  let output='';const child=spawn('bash',[path.join(install,'scripts/drivers/types/antigravity/antigravity-monitor.sh'),'--project',project,'--team','fixture','--name','worker','--agy',fake,'--poll','100'],{env,stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const unread=()=>sh('drivers/types/antigravity/inbox-transport.sh',['peek',project,'fixture','worker',state().owner]).trim();
  const state=()=>{const f=fs.readdirSync(path.join(install,'run')).find(f=>f.endsWith('.state.json'));return JSON.parse(fs.readFileSync(path.join(install,'run',f),'utf8'));};
  return {dir,install,project,env,sh,child,state,unread,output:()=>output,async close(){if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'close'),delay(5000)]);}if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}};
}
for(const driver of ['sqlite','jsonl'])test(`隔離${driver}: 2通をSUCCESS後だけ既読化`,async()=>{
  const f=fixture(driver);try {
    await waitFor(()=>f.output().includes('ready'));
    f.sh('send.sh',['fixture','sender','worker','first']);
    await waitFor(()=>f.output().includes('turn 2')&&f.state().batch===null);
    f.sh('send.sh',['fixture','sender','worker','second']);
    await waitFor(()=>f.output().includes('turn 3')&&f.state().batch===null);
    assert.equal(f.unread(),'');assert.equal(f.state().conversation_id,'fixture-conversation');
  }catch(e){e.message+='\n'+f.output();throw e;}finally{await f.close();}
});
test('stream tool検知は命令だけを見る',()=>{
  const base={event:'step_update',step_update:{step_type:'tool',tool_info:{parameters:{CommandLine:'bash /tmp/inbox.sh team role'}}}};
  assert.equal(forbiddenTool(base),true);
  assert.equal(forbiddenTool({event:'step_update',step_update:{step_type:'agent_response',text_delta:'inbox.sh'}}),false);
  base.step_update.tool_info={parameters:{CommandLine:'echo safe'},output:'inbox.sh'};
  assert.equal(forbiddenTool(base),false);
});

test('予約なしの陽性対照ではinboxの既読化が進む',async()=>{
  const f=fixture();
  try {
    await waitFor(()=>f.output().includes('ready'));
    await f.close();
    f.sh('send.sh',['fixture','sender','worker','positive control']);
    const out=f.sh('inbox.sh',['fixture','worker']);
    assert.match(out,/positive control/);
  } finally { await f.close(); }
});

test('二重起動を拒否する',async()=>{
  const f=fixture();
  try {
    await waitFor(()=>f.output().includes('ready'));
    const second=spawnSync('bash',[path.join(f.install,'scripts/drivers/types/antigravity/antigravity-monitor.sh'),'--project',f.project,'--team','fixture','--name','worker','--agy',path.join(f.dir,'agy'),'--poll','100'],{env:f.env,encoding:'utf8'});
    assert.notEqual(second.status,0);
  } finally { await f.close(); }
});

test('completed batchの明示ack復旧はモデルを再実行しない',async()=>{
  const f=fixture('sqlite','attack');
  try {
    await waitFor(()=>f.output().includes('ready'));
    f.sh('send.sh',['fixture','sender','worker','recover me']);
    await waitFor(()=>f.output().includes('NEEDS_ATTENTION'));
    const before=f.state();
    const ids=before.batch.messages.map(m=>m.id);
    await f.close();
    const r=spawnSync('bash',[path.join(f.install,'scripts/drivers/types/antigravity/antigravity-monitor.sh'),'--project',f.project,'--team','fixture','--name','worker','--agy',path.join(f.dir,'agy'),'--action','ack','--batch',before.batch.id,'--confirm-ids',ids.join(',' )],{env:f.env,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr+r.stdout);
    const after=f.state();
    assert.equal(after.batch,null);
    assert.equal(after.conversation_id,'fixture-conversation');
  } finally { await f.close(); }
});

test('uncertain batchの明示replayは保存済みIDと本文を再投入する',async()=>{
  const f=fixture('sqlite','attack');
  try {
    await waitFor(()=>f.output().includes('ready'));
    f.sh('send.sh',['fixture','sender','worker','replay me']);
    await waitFor(()=>f.output().includes('NEEDS_ATTENTION'));
    const before=f.state();
    const ids=before.batch.messages.map(m=>m.id);
    const body=before.batch.messages[0].body;
    await f.close();
    f.env.FAKE_AGY_MODE='success';
    const child=spawn('bash',[path.join(f.install,'scripts/drivers/types/antigravity/antigravity-monitor.sh'),'--project',f.project,'--team','fixture','--name','worker','--agy',path.join(f.dir,'agy'),'--action','replay','--batch',before.batch.id,'--confirm-ids',ids.join(',') ,'--poll','100'],{env:f.env,stdio:['pipe','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    await waitFor(()=>f.state().batch===null);
    child.kill('SIGTERM');
    await Promise.race([once(child,'close'),delay(5000)]);
    assert.match(output,/turn 2/);
    if (f.state().batch) {
      assert.equal(f.state().batch.messages.length,1);
      assert.equal(f.state().batch.messages[0].body,'late B');
    }
    assert.equal(body,'replay me');
  } finally { await f.close(); }
});

for(const mode of ['attack','append-failure','crash','broken'])test(`異常 ${mode}: batchを保持し自動ackしない`,async()=>{
  const f=fixture('sqlite',mode);try {
    await waitFor(()=>f.output().includes('ready'));
    f.sh('send.sh',['fixture','sender','worker','batch A']);
    await waitFor(()=>f.output().includes('NEEDS_ATTENTION'));
    assert.equal(f.state().batch.phase,'uncertain');
    const unread=f.unread().split('\n').map(JSON.parse);
    assert.equal(unread.length,mode==='attack'||mode==='append-failure'?2:1);
    assert.equal(f.state().batch.messages.length,1);
  }catch(e){e.message+='\n'+f.output();throw e;}finally{await f.close();}
});
