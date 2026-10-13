import test from 'node:test';
import assert from 'node:assert/strict';
import {makeItems} from '../src/queue.js';

test('new tasks create media items only and never create source JSON files',()=>{
  const task={id:'task',context:{accountId:'1'},settingsSnapshot:{
    root:'',folderTemplate:'',filenameTemplate:'{date}_{id}_{index}',metadata:true
  }};
  const content={id:'10',accountId:'1',username:'example',category:'posts',publishedAt:null,
    media:[{id:'11',index:1,extension:'jpg'},{id:'12',index:2,extension:'jpg'}]};
  const items=makeItems(task,[content]);
  assert.deepEqual(items.map(item=>item.type),['media','media']);
  assert.equal(items.some(item=>item.relativePath.endsWith('.json')),false);
});
