import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {pageProbe} from '../src/page-probe.js';
function harness(body) {
  class XHR {open() {} send() {} addEventListener(type,listener){this.listener=listener;} removeEventListener(type,listener){if(this.listener===listener)this.listener=null;}}
  const response={ok:true,status:200,text:async()=>JSON.stringify(body),clone:()=>({text:async()=>JSON.stringify(body)})};
  const calls=[];
  const original=async(...args)=>{calls.push(args);return response;};
  const sandbox={location:new URL('https://www.instagram.com/example/'),document:{cookie:'ds_user_id=200; sessionid=credential'},window:{fetch:original},XMLHttpRequest:XHR,URL,URLSearchParams,Symbol};
  const run=vm.runInNewContext(`(${pageProbe.toString()})`,sandbox);
  return {run,sandbox,original,response,calls};
}
const body={data:{xdt_api__v1__feed__user_timeline_graphql_connection:{edges:[{node:{pk:'123',
  image_versions2:{candidates:[{url:'https://cdn.test/signed-secret',width:1080,height:1440}]},
  caption:{text:'private-caption'},user:{pk:'456',username:'private-username'},token:'credential'}}],
  page_info:{has_next_page:true,end_cursor:'private-cursor'}}}};
const postsRequest={body:'fb_api_req_friendly_name=PolarisProfilePostsTabContentQuery'};
test('automated posts reuse only the observed query, bind the current profile and clear templates on stop',async()=>{
  const content=structuredClone(body);content.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[0].node.user.username='example';
  const {run,sandbox,calls,response}=harness(content);run('start');
  const params=new URLSearchParams({fb_api_req_friendly_name:'PolarisProfilePostsTabContentQuery_connection',doc_id:'12345',
    variables:JSON.stringify({username:'example',after:'old',before:null,first:12,last:null,include_multi_captions:true,data:{count:12}}),sessionid:'credential'});
  await sandbox.window.fetch('/graphql/query',{body:params.toString()});await new Promise(resolve=>setImmediate(resolve));
  const page=await run({type:'read-posts',cursor:null});
  assert.equal(page.context.accountId,'456');
  assert.equal(page.response.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges.length,1);
  const replay=new URLSearchParams(calls.at(-1)[1].body);
  assert.deepEqual([...replay.keys()].sort(),['doc_id','fb_api_req_friendly_name','variables']);
  assert.equal(JSON.parse(replay.get('variables')).after,null);
  await run({type:'read-posts',cursor:'next-page'});
  assert.equal(JSON.parse(new URLSearchParams(calls.at(-1)[1].body).get('variables')).after,'next-page');
  response.status=429;
  assert.equal((await run({type:'read-posts',cursor:null})).code,'RATE_LIMITED');
  response.status=200;
  sandbox.location.pathname='/another/';
  assert.equal((await run({type:'read-posts',cursor:null})).code,'CONTEXT_CHANGED');
  run('stop');assert.equal((await run({type:'read-posts',cursor:null})).code,'READER_NOT_READY');
});
test('probe preserves the page request and returns only structural pagination evidence',async()=>{
  const {run,sandbox,original,response}=harness(body);
  run('start');
  assert.equal(await sandbox.window.fetch('/graphql/query',postsRequest),response);
  await new Promise(resolve=>setImmediate(resolve));
  const report=JSON.parse(JSON.stringify(run('status')));
  assert.equal(report.responses,1);
  assert.equal(report.lists[0].count,1);
  assert.equal(report.lists[0].hasNext,true);
  assert.equal(report.lists[0].hasCursor,true);
  for(const secret of ['signed-secret','private-caption','private-username','private-cursor','credential','123','456'])assert.equal(JSON.stringify(report).includes(secret),false);
  run('stop');
  assert.equal(sandbox.window.fetch,original);
  assert.equal(run('status').active,false);
});
test('probe ignores external responses and captures native XHR without retaining its body',async()=>{
  const {run,sandbox}=harness(body);
  run('start');
  await sandbox.window.fetch('https://evil.test/api/v1/');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(run('status').responses,0);
  const xhr=new sandbox.XMLHttpRequest();
  xhr.open('POST','/graphql/query');
  xhr.send(postsRequest.body);
  xhr.responseType='';xhr.responseText=JSON.stringify(body);xhr.listener();
  assert.equal(run('status').lists.length,1);
  assert.equal(run('start').responses,1);
  run('stop');
});
test('versioned Reels connections retain their own pagination evidence',async()=>{
  const clips={data:{xdt_api__v1__clips__user__connection_v2:{edges:[{node:{media:{pk:'123',media_type:2,
    video_versions:[{url:'signed-secret',width:1080,height:1920}]}}}],page_info:{has_next_page:false,end_cursor:null}}}};
  const {run,sandbox}=harness(clips);
  run('start');await sandbox.window.fetch('/api/graphql',{body:'fb_api_req_friendly_name=PolarisProfileReelsTabContentQuery'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(run('status').lists[0].hasNext,false);
  assert.equal(run('status').lists[0].node.media.media_type,'number');
  run('stop');
});
test('profile Reels use their own nested connection without exposing media or user values',async()=>{
  const clips={data:{fetch__XDTUserDict:{id:'456',clips_connection:{edges:[{node:{media:{pk:'123',
    user:{username:'private-username'},image_versions2:{candidates:[{url:'signed-secret'}]}}}}],
    page_info:{has_next_page:false,end_cursor:null}}}}};
  const {run,sandbox}=harness(clips);
  run('start');await sandbox.window.fetch('/api/graphql',{body:'fb_api_req_friendly_name=PolarisProfileReelsTabContentQuery'});
  await new Promise(resolve=>setImmediate(resolve));
  const report=run('status');
  assert.equal(report.lists[0].name,'clips_connection');
  assert.equal(report.lists[0].hasNext,false);
  assert.equal(report.envelopes[0].userStructure.clips_connection.page_info.end_cursor,'null');
  for(const value of ['signed-secret','private-username','123','456'])assert.equal(JSON.stringify(report).includes(value),false);
  run('stop');
});
test('live validation receives only allowed target media fields and stopping clears the transient sample',async()=>{
  const sample=structuredClone(body);
  sample.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[0].node.user.username='example';
  const {run,sandbox}=harness(sample);
  run('start');await sandbox.window.fetch('/graphql/query',postsRequest);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(run('sample').context.viewerId,'200');
  assert.equal(JSON.stringify(run('sample')).includes('credential'),false);
  assert.equal(JSON.stringify(run('status')).includes('signed-secret'),false);
  run('stop');assert.ok(run('sample').error);
});
test('reusing an XHR for an external destination removes the prior Instagram observer',()=>{
  const {run,sandbox}=harness(body);run('start');
  const xhr=new sandbox.XMLHttpRequest();
  xhr.open('POST','/graphql/query');
  xhr.send(postsRequest.body);
  assert.equal(typeof xhr.listener,'function');
  xhr.open('GET','https://evil.test/api/v1/');
  assert.equal(xhr.listener,null);
  assert.equal(run('status').responses,0);run('stop');
});
test('a Reel detail sample must belong to the observed profile and the opened shortcode',async()=>{
  for(const username of ['example','another']) {
    const {run,sandbox}=harness({items:[{code:'AbC',pk:'123',user:{pk:'456',username},
      video_versions:[{url:'signed-secret',width:1080,height:1920}]}]});
    run('start');sandbox.location.pathname='/reel/AbC/';
    await sandbox.window.fetch('/api/v1/media/123/info/');await new Promise(resolve=>setImmediate(resolve));
    if(username==='example')assert.equal(run('sample').category,'reels');
    else assert.ok(run('sample').error);
    assert.equal(JSON.stringify(run('status')).includes('signed-secret'),false);
    run('stop');assert.ok(run('sample').error);
  }
});
test('account credential and unrelated homepage requests are never cloned for media diagnostics',async()=>{
  const {run,sandbox}=harness(body);run('start');
  await sandbox.window.fetch('/api/graphql',{body:'fb_api_req_friendly_name=PolarisGetEncryptedCredentialsQuery'});
  await sandbox.window.fetch('/graphql/query',{body:'fb_api_req_friendly_name=PolarisFeedRootQuery'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(run('status').responses,0);run('stop');
});
