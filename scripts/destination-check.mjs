import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH ?? 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const profile=await mkdtemp(path.join(tmpdir(),'instakeep-destination-test-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker=context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin=`chrome-extension://${new URL(worker.url()).host}`;
  const page=await context.newPage();await page.goto(`${origin}/ui/destination.html`);
  await page.evaluate(async()=>{
    const {saveDestination}=await import('../src/destination.js');
    await saveDestination(await (await navigator.storage.getDirectory()).getDirectoryHandle('test',{create:true}));
  });
  console.log(await page.evaluate(async()=>{
    const {loadDestination,requireDestination}=await import('../src/destination.js');
    const store=await import('../src/store.js');const {startDownload}=await import('../src/downloads.js');
    const destination=await requireDestination(await loadDestination());
    const task=await store.createTask({accountId:'1',viewerId:'2',username:'test'},['posts'],{metadata:true});
    await store.updateTask(task.id,{destination});
    // Mark the fixture media skipped so this check exercises a real metadata write.
    await store.saveScanPage(task.id,'posts',{context:task.context,contents:[{id:'3',accountId:'1',username:'test',category:'posts',publishedAt:null,permalink:'https://www.instagram.com/p/test/',caption:'test',media:[{id:'4',index:1,kind:'image',extension:'jpg'}]}],nextCursor:null,terminal:true});
    const media=await store.claimNext(task.id);await store.updateItem(media.id,{state:'skipped'});
    const claim=await store.claimNext(task.id);if(!claim)throw new Error('missing claim');
    await startDownload(claim);
    const saved=(await store.loadItems(task.id)).find(item=>item.type==='metadata');
    if(saved.state!=='succeeded')throw new Error('write not confirmed');
    let dir=destination.handle;const parts=saved.relativePath.split('/');
    for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);
    const original=await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text();
    await store.updateItem(saved.id,{state:'starting'});await startDownload({...saved,state:'starting'});
    const second=(await store.loadItems(task.id)).find(item=>item.type==='metadata');
    if(second.relativePath===saved.relativePath)throw new Error('overwritten');
    if(original!==await (await (await dir.getFileHandle(parts.at(-1))).getFile()).text())throw new Error('original changed');
    return 'PASS: directory handle persisted; direct JSON write and no-overwrite confirmed';
  }));
  console.log(await page.evaluate(async()=>{
    const store=await import('../src/store.js');
    const {runTask}=await import('../src/jobs.js');
    const {loadDestination,saveDestination}=await import('../src/destination.js');
    const {pauseTask}=await import('../src/downloads.js');
    const destination=await loadDestination();
    const context={accountId:'100',viewerId:'200',username:'batch_test'};
    const post=(id,kind)=>({pk:id,code:`Post_${id}`,user:{pk:'100',username:'batch_test'},taken_at:1790812800,
      media_type:kind==='video'?2:1,...(kind==='video' ? {video_versions:[{url:'https://video.example.fbcdn.net/file.mp4',width:100,height:100}]}:
        {image_versions2:{candidates:[{url:'https://image.example.cdninstagram.com/file.jpg',width:100,height:100}]}})});
    const posts=[post('300','image'),post('301','video')];
    const task=await store.createTask(context,['posts'],{metadata:true});
    await store.updateTask(task.id,{tabId:7,destination});
    const originalGet=chrome.tabs.get,originalExecute=chrome.scripting.executeScript,originalFetch=globalThis.fetch;
    let pages=0,requests=0;
    try {
      chrome.tabs.get=async()=>({url:'https://www.instagram.com/batch_test/'});
      chrome.scripting.executeScript=async({args:[input]})=>{
        if(input.contentId)return [{result:{detail:posts.find(post=>post.pk===input.contentId),context}}];
        pages++;
        const index=input.cursor===null?0:1;
        return [{result:{context,response:{data:{xdt_api__v1__feed__user_timeline_graphql_connection:{
          edges:[{node:posts[index]}],page_info:{has_next_page:index===0,end_cursor:index===0?'next':null}}}}}}];
      };
      globalThis.fetch=async(url)=>{
        requests++;
        if(requests===1)await pauseTask(task.id);
        return new Response(new Uint8Array([1,2,3,4]),{headers:{'content-type':url.endsWith('.mp4')?'video/mp4':'image/jpeg'}});
      };
      await runTask(task.id);
      if((await store.loadTask(task.id)).state!=='paused')throw new Error('pause ignored');
      const before=await store.loadItems(task.id);
      if(before.filter(item=>item.type==='media' && item.state==='succeeded').length!==1)throw new Error('in-flight write not recorded');
      if(!before.some(item=>item.state==='pending'))throw new Error('pause lost pending queue');
      await saveDestination(await (await navigator.storage.getDirectory()).getDirectoryHandle('different',{create:true}));
      await store.updateTask(task.id,{state:'downloading'});
      await runTask(task.id);
      const final=await store.loadItems(task.id);
      if((await store.loadTask(task.id)).state!=='complete' || final.some(item=>item.state!=='succeeded'))throw new Error('resume did not complete every file');
      if(pages!==2 || requests!==2)throw new Error('resume rescanned pages or redownloaded finished media');
      if(final.some(item=>!item.actualPath.startsWith('test/')))throw new Error('current task followed changed destination');
      for(const item of final){
        let directory=destination.handle;const parts=item.relativePath.split('/');
        for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part);
        const file=await (await directory.getFileHandle(parts.at(-1))).getFile();
        if(item.type==='media' && file.size!==4)throw new Error('media stream not written');
        if(item.type==='metadata'){
          const metadata=JSON.parse(await file.text());
          if(metadata.media.some(media=>!final.some(candidate=>candidate.type==='media' && candidate.actualPath===media.path)))throw new Error('metadata path mismatch');
        }
      }
      const networkTask=await store.createTask(context,['posts'],{metadata:false,force:true});
      await store.updateTask(networkTask.id,{tabId:7,destination});
      await store.saveScanPage(networkTask.id,'posts',{context,contents:[{id:'300',accountId:'100',username:'batch_test',category:'posts',publishedAt:null,permalink:'https://www.instagram.com/p/test/',caption:'',media:[{id:'300',index:1,kind:'image',extension:'jpg'}]}],nextCursor:null,terminal:true});
      globalThis.fetch=async()=>{throw new TypeError('temporary network loss');};
      await runTask(networkTask.id);
      const networkItem=(await store.loadItems(networkTask.id))[0];
      if(networkItem.state!=='pending' || networkItem.attempts!==1 || networkItem.nextRetryAt<=Date.now())throw new Error('network failure did not schedule bounded retry');
      await store.updateItem(networkItem.id,{nextRetryAt:0});
      globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3,4]),{headers:{'content-type':'image/jpeg'}});
      await runTask(networkTask.id);
      if((await store.loadTask(networkTask.id)).state!=='complete')throw new Error('temporary network failure did not recover');
      const mixed={...post('302','image'),media_type:8,carousel_media_count:2,carousel_media:[post('304','image'),post('305','video')]};
      posts.push(mixed);
      const imageTask=await store.createTask(context,['posts'],{metadata:true});
      await store.updateTask(imageTask.id,{tabId:7,destination,singleContentId:'302',imagesOnly:true});
      await runTask(imageTask.id);
      const imageItems=await store.loadItems(imageTask.id);
      if((await store.loadTask(imageTask.id)).state!=='complete' || imageItems.filter(item=>item.type==='media').length!==1 || imageItems.some(item=>item.relativePath.endsWith('.mp4')))throw new Error('image-only button included carousel video');
      if(imageItems.find(item=>item.type==='metadata').payload.media.length!==1)throw new Error('image-only metadata listed excluded media');
      const repeat=await store.createTask(context,['posts'],{metadata:true});
      await store.updateTask(repeat.id,{destination});
      await store.saveScanPage(repeat.id,'posts',{context,contents:posts.slice(0,2).map(post=>({id:post.pk,accountId:'100',username:'batch_test',category:'posts',publishedAt:null,permalink:'https://www.instagram.com/p/test/',caption:'',media:[{id:post.pk,index:1,kind:post.media_type===2?'video':'image',extension:post.media_type===2?'mp4':'jpg'}]})),nextCursor:null,terminal:true});
      if((await store.loadItems(repeat.id)).some(item=>item.state!=='skipped'))throw new Error('completed directory not deduplicated');
      return 'PASS: two-page batch, image/video streaming, pause/resume, frozen destination, metadata paths and same-directory deduplication';
    }finally{chrome.tabs.get=originalGet;chrome.scripting.executeScript=originalExecute;globalThis.fetch=originalFetch;}
  }));
  console.log(await worker.evaluate(async()=>{const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('test');if(await dir.queryPermission({mode:'readwrite'})!=='granted')throw new Error('worker permission');return 'PASS: service worker can access directory handle and write permission';}));
}finally{await context?.close();await rm(profile,{recursive:true,force:true});}
