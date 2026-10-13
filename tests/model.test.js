import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaKey, completion } from '../src/model.js';
test('stable identity survives source category and temporary URL changes', () => {
  assert.equal(mediaKey({id:'12',index:1,url:'old'}), mediaKey({id:'12',index:1,url:'new'}));
  assert.notEqual(mediaKey({id:'12',index:1}),mediaKey({id:'12',index:2}));
  assert.throws(() => mediaKey({index:1}), /身份/);
});
test('backup complete requires all selected scans and required files', () => {
  const task = {selectedCategories:['posts','stories'],scans:{posts:{state:'complete'},stories:{state:'complete'}}};
  assert.equal(completion(task,[{state:'succeeded'},{state:'skipped'}]),'complete');
  for (const state of ['failed','unknown','pending','starting','downloading']) {
    assert.equal(completion(task,[{type:'metadata',state}]),'incomplete');
  }
  task.scans.stories.state = 'unknown';
  assert.equal(completion(task,[]),'incomplete');
  assert.equal(completion({selectedCategories:[],scans:{}},[]),'incomplete');
});
