import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPath, validateSettings, highlightFolders } from '../src/paths.js';
const content = {id:'500',username:'example',category:'posts',publishedAt:'2026-10-01T10:00:00Z',media:[{},{}]};
const media = {id:'501',index:2,extension:'jpg'};
test('default layout preserves carousel identity and deterministic UTC dates', () => {
  assert.equal(buildPath(content,media,{}),'2026-10-01_500_2.jpg');
  assert.equal(buildPath({...content,publishedAt:null},media,{}),'500_2.jpg');
  assert.equal(buildPath({...content,category:'reels',media:[media]}, {...media,index:1,extension:'mp4'},{}),
    '2026-10-01_500.mp4');
});
test('custom templates change layout without losing identity', () => {
  assert.equal(buildPath(content,media,{root:'Archive',folderTemplate:'{type}/{username}',filenameTemplate:'{username}_{id}_{index}'}),
    'Archive/posts/example/example_500_2.jpg');
});
test('omitting carousel index cannot give different media the same archived path', () => {
  for (const filenameTemplate of ['{id}','{username}','{username}_{index}']) {
    const first = buildPath(content,{...media,index:1},{filenameTemplate});
    const second = buildPath(content,media,{filenameTemplate});
    assert.notEqual(first,second);
    assert.ok(second.endsWith('_2.jpg'));
  }
});
test('absolute paths, traversal, unknown placeholders and unsupported media are rejected', () => {
  for (const root of ['/tmp','../outside','C:\\temp','one/../two']) assert.equal(validateSettings({root}).valid,false);
  for (const filenameTemplate of ['../x','{password}','x/y','']) assert.equal(validateSettings({filenameTemplate}).valid,false);
  assert.throws(()=>buildPath(content,{...media,extension:'exe'},{}),/格式/);
});
test('highlight titles with filesystem-equivalent spelling do not collide', () => {
  const names = highlightFolders([{id:'1',title:'Trip?'},{id:'2',title:'Trip*'},{id:'3',title:'Summer'}]);
  assert.notEqual(names['1'],names['2']);
  assert.equal(names['3'],'Summer');
  assert.equal(buildPath({...content,category:'highlights',highlight:{id:'1',title:'Trip?'},media:[media]},media,
    {highlightFolders:names}), 'Trip__1/2026-10-01_500.jpg');
});

test('empty subfolder settings save directly inside the chosen directory',()=>{
  assert.equal(validateSettings({root:'',folderTemplate:''}).valid,true);
  assert.equal(buildPath(content,media,{root:'',folderTemplate:''}),'2026-10-01_500_2.jpg');
  assert.equal(buildPath(content,media,{root:'Optional',folderTemplate:''}),'Optional/2026-10-01_500_2.jpg');
  assert.equal(validateSettings({folderTemplate:'../outside'}).valid,false);
});
