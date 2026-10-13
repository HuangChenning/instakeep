import test from 'node:test';
import assert from 'node:assert/strict';
import { retryPolicy, recoveredState, downloadOptions, runPool } from '../src/downloads.js';
test('only Chrome complete confirms success, missing associations stay unknown', () => {
  assert.equal(recoveredState({state:'starting',downloadId:null},null),'unknown');
  assert.equal(recoveredState({state:'downloading',downloadId:7},{id:8,state:'complete'}),'unknown');
  assert.equal(recoveredState({state:'downloading',downloadId:7},{id:7,state:'complete'}),'succeeded');
  assert.equal(recoveredState({state:'downloading',downloadId:7},{id:7,state:'in_progress'}),'downloading');
  assert.equal(recoveredState({state:'downloading',downloadId:7},{id:7,state:'interrupted'}),'failed');
});
test('temporary failures retry three times, cancellation and filesystem failures do not', () => {
  assert.deepEqual(retryPolicy('NETWORK_FAILED',1),{retry:true,delay:2000});
  assert.deepEqual(retryPolicy('NETWORK_FAILED',2),{retry:true,delay:5000});
  assert.deepEqual(retryPolicy('NETWORK_TIMEOUT',3),{retry:true,delay:15000});
  for(const reason of ['USER_CANCELED','FILE_ACCESS_DENIED','SERVER_UNAUTHORIZED']) assert.equal(retryPolicy(reason,1).retry,false);
  assert.equal(retryPolicy('NETWORK_FAILED',4).retry,false);
});
test('downloads never overwrite and unsupported locations cannot receive arbitrary requests', () => {
  const options=downloadOptions({relativePath:'Instagram/a.json',type:'metadata',payload:{id:'1'}});
  assert.equal(options.conflictAction,'uniquify');
  assert.equal(options.saveAs,false);
  assert.ok(options.url.startsWith('data:application/json'));
  assert.throws(()=>downloadOptions({relativePath:'../x',type:'metadata',payload:{}}),/路径/);
  assert.throws(()=>downloadOptions({relativePath:'x.jpg',type:'media'},'https://evil.test/a'),/媒体/);
});
test('direct writes run with bounded concurrency',async()=>{
  const pending=[1,2,3,4,5,6];let active=0;let maximum=0;
  await runPool(2,async()=>pending.shift() ?? null,async()=>{
    active++;maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,5));
    active--;
  });
  assert.equal(maximum,2);
  assert.equal(pending.length,0);
});
