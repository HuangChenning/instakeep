import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,requireDestination} from '../src/destination.js';
test('lost directory authorization prevents unattended writes',async()=>{
  await assert.rejects(requireDestination({handle:{queryPermission:async()=> 'prompt'}}),/授权/);
});
test('existing backups are preserved and success waits for the file to close',async()=>{
  const files=new Map([['image.jpg','original']]);let closed=false;
  const directory={getDirectoryHandle:async()=>directory,getFileHandle:async(name,options)=>{
    if(!options && !files.has(name))throw new DOMException('missing','NotFoundError');
    return {createWritable:async()=>({write:async data=>files.set(name,data),close:async()=>{closed=true;}})};
  }};
  const path=await writeFile(directory,'posts/image.jpg','new');
  assert.equal(files.get('image.jpg'),'original');assert.notEqual(path,'posts/image.jpg');
  assert.equal(files.get(path.split('/').at(-1)),'new');assert.equal(closed,true);
});
