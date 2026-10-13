import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { readContext } from '../src/page-reader.js';
function read(url, cookie, objects = [], inspect = false) {
  const sandbox = { location: new URL(url), document: {cookie,
    querySelectorAll: () => objects.map(value => ({textContent: JSON.stringify(value)}))} };
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${readContext.toString()})(${inspect})`, sandbox)));
}
test('structure diagnostics expose media and pagination shapes without account or credential values', () => {
  const result = read('https://www.instagram.com/example/','ds_user_id=123; sessionid=secret',[
    {username:'example',pk:'456',caption:'private-caption',token:'secret',
      media:{pk:'789',image_versions2:{candidates:[{url:'https://cdn.test/signed-secret',width:1080,height:1440}]},
        carousel_media:[{video_versions:[{url:'secret',width:1080}]}]},
      page_info:{has_next_page:true,end_cursor:'secret-cursor'}}
  ],true);
  assert.equal(result.evidence.mediaObjects,2);
  assert.deepEqual(result.evidence.pagination,[{has_next_page:true,hasCursor:true}]);
  const text = JSON.stringify(result.evidence);
  for (const value of ['secret','private-caption','789','456','123']) assert.equal(text.includes(value),false);
  assert.ok(text.includes('image_versions2'));
  assert.ok(text.includes('candidates'));
});
test('only a logged-in Instagram profile provides a backup context', () => {
  assert.deepEqual(read('https://www.instagram.com/example/', 'ds_user_id=123',
    [{data: {user: {username:'example', pk:'456'}}}]),
    {username:'example', accountId:'456', viewerId:'123'});
});
test('navigation and external pages cannot become backup targets', () => {
  for (const url of ['https://www.instagram.com/explore/', 'https://www.instagram.com/p/abc/',
    'https://www.instagram.com/accounts/', 'https://evil.test/example/']) {
    assert.throws(() => read(url, 'ds_user_id=123'), /主页/);
  }
});
test('missing login or stable profile identity must not look like success', () => {
  assert.throws(() => read('https://www.instagram.com/example/', ''), /登录/);
  assert.throws(() => read('https://www.instagram.com/example/', 'ds_user_id=123'), /身份/);
});
test('diagnostics remain available when page identity is missing without accepting a backup target', () => {
  const result = read('https://www.instagram.com/example/','ds_user_id=123',[],true);
  assert.equal(result.accountId,null);
  assert.equal(result.evidence.identityMatches,0);
  assert.throws(()=>read('https://www.instagram.com/example/','ds_user_id=123',[]),/身份/);
});
test('mismatched embedded users cannot silently replace the chosen profile', () => {
  assert.throws(() => read('https://www.instagram.com/example/', 'ds_user_id=123',
    [{username:'someone_else', pk:'999'}]), /身份/);
});

test('diagnostic copy does not promise a valid server session', async () => {
  const text = await readFile(new URL('../ui/popup.js', import.meta.url), 'utf8');
  assert.equal(text.includes('登录状态已确认'), false);
  assert.ok(text.includes('登录有效性仍待验证'));
});
