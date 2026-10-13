import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readSource} from '../src/source.js';
const context={username:'example',accountId:'100',viewerId:'200'};
const query={path:'/graphql/query',docId:'12345',variables:{after:null,first:12,data:{count:12}}};
function harness(data,status=200) {
  const calls=[];
  const sandbox={location:new URL('https://www.instagram.com/example/'),document:{cookie:'ds_user_id=200; csrftoken=csrf; sessionid=secret'},
    URL,URLSearchParams,setTimeout:resolve=>resolve(),fetch:async(...args)=>{calls.push(args);return {ok:status===200,status,text:async()=>JSON.stringify(data)};}};
  return {run:vm.runInNewContext(`(${readSource.toString()})`,sandbox),sandbox,calls};
}
test('source requests only an observed same-origin query and strips credentials from its result',async()=>{
  const {run,calls}=harness({data:{xdt_api__v1__feed__user_timeline_graphql_connection:{edges:[{node:{pk:'300',token:'secret'}}],page_info:{has_next_page:false,end_cursor:null}},token:'secret'}});
  const result=await run({context,query,category:'posts'});
  assert.equal(result.response.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[0].node.pk,'300');
  assert.equal(JSON.stringify(result).includes('secret'),false);
  assert.equal(calls[0][0],'/graphql/query');
  assert.equal(JSON.parse(new URLSearchParams(calls[0][1].body).get('variables')).username,'example');
});
test('navigation, changed viewers and arbitrary request destinations cannot read a backup source',async()=>{
  const {run,sandbox,calls}=harness({});
  sandbox.document.cookie='ds_user_id=201';
  assert.equal((await run({context,query,category:'posts'})).code,'CONTEXT_CHANGED');
  sandbox.document.cookie='ds_user_id=200';
  assert.equal((await run({context,query:{...query,path:'https://evil.test'},category:'posts'})).code,'READER_NOT_READY');
  sandbox.location.pathname='/other/';
  assert.equal((await run({context,query,category:'posts'})).code,'CONTEXT_CHANGED');
  assert.equal(calls.length,0);
});
test('access restrictions pause callers rather than produce an empty completed page',async()=>{
  for(const [status,code] of [[429,'RATE_LIMITED'],[401,'LOGIN_REQUIRED'],[403,'LOGIN_REQUIRED']]) {
    const {run}=harness({},status);assert.equal((await run({context,query,category:'posts'})).code,code);
  }
});
test('detail refresh accepts only the requested media identity',async()=>{
  const {run,calls}=harness({items:[{pk:'301',user:{pk:'100',username:'example'}}]});
  assert.equal((await run({context,category:'posts',contentId:'300'})).code,'READ_FAILED');
  assert.equal(calls[0][0],'/api/v1/media/300/info/');
});
test('a single post is identified from its shortcode and keeps every carousel item for normalization',async()=>{
  const {run,sandbox,calls}=harness({items:[{pk:'300',code:'Es',media_type:8,carousel_media_count:2,
    user:{pk:'100',username:'example'},carousel_media:[{pk:'301'},{pk:'302'}],sessionid:'secret'}]});
  sandbox.document.scripts=[{textContent:'[\"JSErrorLoggingConfig\",[],{\"appId\":936619743392459}]'}];
  sandbox.location.pathname='/p/Es/';
  const result=await run({category:'posts',single:true});
  assert.equal(calls[0][0],'/api/v1/media/300/info/');
  assert.equal(calls[0][1].headers['X-IG-App-ID'],'936619743392459');
  assert.equal(result.context.postCode,'Es');
  assert.equal(result.context.accountId,'100');
  assert.equal(result.detail.carousel_media.length,2);
  assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('a different returned shortcode cannot become a successful single-post backup',async()=>{
  const {run,sandbox}=harness({items:[{pk:'300',code:'other',user:{pk:'100',username:'example'}}]});
  sandbox.location.pathname='/p/Es/';
  assert.equal((await run({category:'posts',single:true})).code,'READ_FAILED');
});
test('a home-feed button binds the request to its own post permalink',async()=>{
  const {run,sandbox,calls}=harness({items:[{pk:'300',code:'Es',media_type:1,
    user:{pk:'100',username:'example'},image_versions2:{candidates:[{url:'https://img.cdninstagram.com/a.jpg',width:100,height:100}]}}]});
  sandbox.location.pathname='/';
  sandbox.document.scripts=[{textContent:'[\"JSErrorLoggingConfig\",[],{\"appId\":936619743392459}]'}];
  const result=await run({category:'posts',single:true,singlePath:'/p/Es/'});
  assert.equal(calls[0][0],'/api/v1/media/300/info/');
  assert.equal(result.context.postPath,'/p/Es/');
  assert.equal(result.context.sourcePath,'/');
});
test('a feed request rejects invalid post paths before contacting Instagram',async()=>{
  const {run,sandbox,calls}=harness({});
  sandbox.location.pathname='/';
  assert.equal((await run({category:'posts',single:true,singlePath:'https://evil.test/p/Es/'})).code,'CONTEXT_CHANGED');
  assert.equal(calls.length,0);
});
