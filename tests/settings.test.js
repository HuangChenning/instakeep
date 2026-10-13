import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSettings,saveSettings} from '../src/store.js';
import {DEFAULT_SETTINGS} from '../src/paths.js';
let saved;
let directoryLayoutVersion;
globalThis.chrome={storage:{local:{get:async()=>({settings:saved,directoryLayoutVersion}),set:async(value)=>{saved=structuredClone(value.settings);directoryLayoutVersion=value.directoryLayoutVersion;}}}};
test('local preferences preserve only naming options, never credentials, metadata or force flags',async()=>{
  assert.deepEqual(await loadSettings(),DEFAULT_SETTINGS);
  await saveSettings({root:'Archive',metadata:false,sessionid:'credential',force:true});
  assert.equal((await loadSettings()).root,'Archive');
  assert.equal(JSON.stringify(saved).includes('credential'),false);
  assert.equal(saved.metadata,undefined);
  assert.equal(saved.force,undefined);
  assert.equal(chrome.storage.sync,undefined);
});
test('invalid layouts cannot overwrite valid preferences',async()=>{
  const previous=structuredClone(saved);
  await assert.rejects(saveSettings({root:'../outside'}),/相对路径/);
  assert.deepEqual(saved,previous);
});

test('previous automatic Instagram subfolders migrate to the chosen directory itself',async()=>{
  directoryLayoutVersion=undefined;
  saved={root:'Instagram',folderTemplate:'{username}/{type}',filenameTemplate:'{date}_{id}_{index}',metadata:true};
  assert.equal((await loadSettings()).root,'');assert.equal((await loadSettings()).folderTemplate,'');
  assert.equal(saved.root,'');assert.equal(saved.folderTemplate,'');
});

test('one-time layout migration preserves later explicit subfolder choices',async()=>{
  await saveSettings({root:'Instagram',folderTemplate:'{username}/{type}'});
  assert.equal((await loadSettings()).root,'Instagram');
  assert.equal((await loadSettings()).folderTemplate,'{username}/{type}');
});
