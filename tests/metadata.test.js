import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetadata } from '../src/metadata.js';
test('archives provenance without persisting signed URLs or credentials', () => {
  const result = buildMetadata({id:'12',accountId:'34',username:'example',permalink:'https://www.instagram.com/p/test/',
    category:'posts',caption:'Caption',publishedAt:null,viewerId:'secret',media:[{id:'56',index:1,kind:'image',url:'signed?token=secret',qualityNote:null}]},['a.jpg']);
  assert.equal(result.media[0].path,'a.jpg');
  assert.equal(result.publishedAt,null);
  assert.equal(JSON.stringify(result).includes('secret'),false);
  assert.equal(result.permalink,'https://www.instagram.com/p/test/');
});
