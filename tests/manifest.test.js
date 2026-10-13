import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
test('personal backup shell requires no broad host or credential permissions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.toSorted(), ['activeTab','alarms', 'downloads', 'scripting','storage']);
  assert.deepEqual(manifest.host_permissions,['https://*.cdninstagram.com/*','https://*.fbcdn.net/*','https://www.instagram.com/*','https://instagram.com/*']);
  assert.deepEqual(manifest.content_scripts[0].matches,['https://www.instagram.com/*','https://instagram.com/*']);
  await access(new URL('../src/post-button.js',import.meta.url));
  assert.equal(manifest.background.type, 'module');
  await access(new URL(`../${manifest.background.service_worker}`, import.meta.url));
  await access(new URL(`../${manifest.action.default_popup}`, import.meta.url));
});
