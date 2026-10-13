import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeContent,normalizePage} from '../src/instagram.js';
import {mediaKey} from '../src/model.js';
const context={accountId:'100',viewerId:'200',username:'example'};
const image=(pk)=>({pk,id:`${pk}_100`,media_type:1,image_versions2:{candidates:[
  {url:'https://scontent.example.cdninstagram.com/small.jpg',width:320,height:400},
  {url:'https://scontent.example.cdninstagram.com/large.jpg?temporary=secret',width:1080,height:1350}]}});
const post={...image('300'),code:'Example_1',user:{pk:'100',username:'example'},taken_at:1790812800,
  media_type:8,carousel_media_count:2,carousel_media:[image('301'),{pk:'302',media_type:2,
    video_versions:[{url:'https://video.example.fbcdn.net/video.mp4',width:1080,height:1920}]}],caption:{text:'archive me'}};
const response=(node,info)=>({data:{xdt_api__v1__feed__user_timeline_graphql_connection:{edges:node?[{node}]:[],page_info:info}}});
test('archives every carousel slide and selects the largest available media instead of its cover',()=>{
  const result=normalizeContent(post,context,'posts');
  assert.equal(result.media.length,2);
  assert.equal(result.media[0].id,'301');assert.equal(result.media[0].index,1);
  assert.equal(result.media[0].width,1080);assert.equal(result.media[0].extension,'jpg');
  assert.equal(result.media[1].kind,'video');assert.equal(result.media[1].extension,'mp4');
  assert.equal(result.caption,'archive me');
  assert.equal(mediaKey(result.media[1]),mediaKey(normalizeContent(post,context,'reels').media[1]));
  assert.equal(normalizeContent({...post,taken_at:null},context,'posts').publishedAt,null);
});
test('incomplete carousels, wrong owners, preview-only videos and external URLs cannot look backed up',()=>{
  assert.throws(()=>normalizeContent({...post,carousel_media_count:3},context,'posts'),/轮播/);
  assert.throws(()=>normalizeContent({...post,user:{pk:'999',username:'someone'}},context,'posts'),/账号/);
  assert.throws(()=>normalizeContent({...image('300'),media_type:2,code:'Example_1',user:post.user},context,'posts'),/视频/);
  const bad={...image('300'),image_versions2:{candidates:[{url:'https://evil.test/x.jpg',width:1080,height:1920}]},code:'Example_1',user:post.user};
  assert.throws(()=>normalizeContent(bad,context,'posts'),/媒体地址/);
});
test('only the verified profile connection and explicit server end marker can complete a scan',()=>{
  const page=normalizePage(response(post,{has_next_page:true,end_cursor:'next'}),context,'posts');
  assert.equal(page.terminal,false);assert.equal(page.nextCursor,'next');
  assert.equal(normalizePage(response(null,{has_next_page:false,end_cursor:null}),context,'posts').terminal,true);
  assert.throws(()=>normalizePage(response(post,{has_next_page:true,end_cursor:'next'}),context,'posts','next'),/重复/);
  assert.throws(()=>normalizePage(response(null,{has_next_page:true,end_cursor:'next'}),context,'posts'),/空页/);
  assert.throws(()=>normalizePage(response(post,{}),context,'posts'),/分页/);
  assert.throws(()=>normalizePage({data:{xdt_api__v1__media__media_id__comments__connection:{edges:[],page_info:{has_next_page:false,end_cursor:null}}}},context,'posts'),/主页/);
  assert.throws(()=>normalizePage({},context,'stories'),/尚未验证/);
});
