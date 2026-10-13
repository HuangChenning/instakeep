import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH ?? 'playwright');
const root = path.resolve(import.meta.dirname,'..');
const profile = await mkdtemp(path.join(tmpdir(),'instakeep-test-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {channel:'chromium',headless:true,
    downloadsPath:path.join(profile,'downloads'),
    args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker',{timeout:15000});
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/ui/popup.html`);
  if (await page.title() !== 'InstaKeep · IG 留存') throw new Error('Extension UI did not load');
  console.log('PASS: unpacked MV3 extension and popup load in Chromium',context.browser()?.version());
  const result = await page.evaluate(async () => {
    const store = await import(chrome.runtime.getURL('src/store.js'));
    const expect = (condition,message) => {if(!condition)throw new Error(message);};
    await store.saveSettings({root:'BrowserArchive',metadata:false});
    expect((await store.loadSettings()).root==='BrowserArchive','local preferences must persist through the Chrome storage API');
    const context = {accountId:'100',viewerId:'200',username:'example'};
    const media = {id:'501',index:1,kind:'image',extension:'jpg',url:'temporary-secret-url'};
    const content = {id:'500',accountId:'100',username:'example',category:'posts',publishedAt:null,
      permalink:'https://www.instagram.com/p/test/',caption:'test',media:[media,{...media,id:'502',index:2}]};
    const task = await store.createTask(context,['posts'],{metadata:true});
    await store.saveScanPage(task.id,'posts',{context,contents:[content],nextCursor:'page2',terminal:false});
    let items = await store.loadItems(task.id);
    expect(items.length === 3,'every carousel media and optional source JSON must be queued');
    expect(!JSON.stringify(items).includes('temporary-secret'),'signed URLs must not be persisted');
    await store.saveScanPage(task.id,'posts',{context,contents:[{...content,category:'reels'}],nextCursor:null,terminal:true});
    expect((await store.loadItems(task.id)).length === 3,'duplicate media and metadata must be unique within a task');
    const claims = await Promise.all([store.claimNext(task.id),store.claimNext(task.id)]);
    expect(claims.every(Boolean) && claims[0].id !== claims[1].id,'concurrent claim must be atomic');
    expect(claims.every(item=>item.type==='media'),'source JSON must wait for every media file');
    expect(await store.claimNext(task.id) === null,'source JSON cannot race unfinished media');
    for (const [index,item] of claims.entries()) {
      await store.attachDownload(item.id,123+index);
      await store.markSucceeded(item.id,123+index,item.relativePath.replace('.jpg',' (1).jpg'),
        index===0 ? '/custom-save-folder/actual (1).jpg':undefined);
    }
    const metadata=await store.claimNext(task.id);
    expect(metadata.type==='metadata' && metadata.payload.media.every(media=>media.path.endsWith(' (1).jpg')),
      'source JSON must reference actual Chrome filenames after uniquify');
    expect(metadata.payload.media[0].path==='/custom-save-folder/actual (1).jpg',
      'a save dialog may change directories; provenance must use the actual Chrome path');
    await store.attachDownload(metadata.id,125);
    await store.markSucceeded(metadata.id,125);
    const next = await store.createTask(context,['posts'],{metadata:true});
    await store.saveScanPage(next.id,'posts',{context,contents:[content],nextCursor:null,terminal:true});
    expect((await store.loadItems(next.id)).every(item=>item.state==='skipped'),'new task skips completed files');
    const forced=await store.createTask(context,['posts'],{metadata:false,force:true});
    await store.saveScanPage(forced.id,'posts',{context,contents:[content],nextCursor:null,terminal:true});
    expect((await store.loadItems(forced.id)).every(item=>item.state==='pending'),'explicit force bypasses completed records');
    const settings={root:'Original',metadata:false};
    const snapshot=await store.createTask(context,['posts'],settings);
    settings.root='Changed';
    expect((await store.loadTask(snapshot.id)).settingsSnapshot.root==='Original','existing task layout must remain frozen');
    const cyclic=await store.createTask(context,['posts'],{metadata:false});
    for(const nextCursor of ['A','B','A'])await store.saveScanPage(cyclic.id,'posts',{context,contents:[content],nextCursor,terminal:false});
    const cyclicTask=await store.loadTask(cyclic.id);
    expect(cyclicTask.scans.posts.state==='unknown' && cyclicTask.state==='paused','cursor cycles must pause without claiming completeness');
    const failedContent={...content,id:'700',media:[{...media,id:'701'}]};
    const failed=await store.createTask(context,['posts'],{metadata:false});
    await store.saveScanPage(failed.id,'posts',{context,contents:[failedContent],nextCursor:null,terminal:true});
    await store.updateItem((await store.loadItems(failed.id))[0].id,{state:'failed'});
    const retry=await store.createTask(context,['posts'],{metadata:false});
    await store.saveScanPage(retry.id,'posts',{context,contents:[failedContent],nextCursor:null,terminal:true});
    expect((await store.loadItems(retry.id))[0].state==='pending','failed files must not become completion records');
    const fresh = {...content,id:'600',media:[{...media,id:'601'}]};
    const third = await store.createTask(context,['posts'],{metadata:false});
    await store.saveScanPage(third.id,'posts',{context,contents:[content,fresh],nextCursor:null,terminal:true});
    expect((await store.loadItems(third.id)).filter(item=>item.state==='pending').length===1,'only new media is pending');
    let rejected=false;
    try {await store.saveScanPage(third.id,'posts',{context:{...context,viewerId:'300'},contents:[fresh],nextCursor:'bad',terminal:false});}
    catch {rejected=true;}
    expect(rejected,'viewer changes must fail');
    expect((await store.loadTask(third.id)).scans.posts.cursor === null,'failed page must not advance checkpoint');
    await store.closeStore();
    expect((await store.loadItems(third.id)).length === 3,'database must survive connection reopening');
    await store.clearAccountHistory('100');
    const fourth = await store.createTask(context,['posts'],{metadata:false});
    await store.saveScanPage(fourth.id,'posts',{context,contents:[content],nextCursor:null,terminal:true});
    expect((await store.loadItems(fourth.id))[0].state==='pending','clearing history permits a new download');
    return {taskId:third.id,message:'PASS: real IndexedDB duplicate suppression, atomic claims, checkpoints, reopening and account history'};
  });
  console.log(result.message);
  console.log(await page.evaluate(async()=>{
    const store=await import(chrome.runtime.getURL('src/store.js'));
    const jobs=await import(chrome.runtime.getURL('src/jobs.js'));
    const context={accountId:'800',viewerId:'801',username:'job_test',postCode:'Es',postPath:'/p/Es/'};
    const content={id:'300',accountId:'800',username:'job_test',category:'posts',publishedAt:null,
      permalink:'https://www.instagram.com/p/Es/',caption:'',media:[{id:'803',index:1,kind:'image',extension:'jpg'}]};
    const previous=await store.createTask(context,['posts'],{metadata:false});
    await store.saveScanPage(previous.id,'posts',{context,contents:[content],nextCursor:null,terminal:true});
    const item=await store.claimNext(previous.id);
    await store.attachDownload(item.id,800);
    await store.markSucceeded(item.id,800,null,'/test/actual.jpg');
    await store.updateTask(previous.id,{state:'complete'});
    const task=await store.createTask(context,['posts'],{metadata:false});
    await store.updateTask(task.id,{tabId:7,singleContentId:'300'});
    const originalGet=chrome.tabs.get;
    const originalExecute=chrome.scripting.executeScript;
    try {
      chrome.tabs.get=async()=>({url:'https://www.instagram.com/p/Es/'});
      chrome.scripting.executeScript=async()=>[{result:{context,detail:{pk:'300',code:'Es',media_type:8,carousel_media_count:1,
        user:{pk:'800',username:'job_test'},carousel_media:[{pk:'803',media_type:1,
          image_versions2:{candidates:[{url:'https://cdninstagram.com/test.jpg',width:100,height:100}]}}]}}}];
      await jobs.runTask(task.id);
      if((await store.loadTask(task.id)).state!=='complete' || (await store.loadItems(task.id))[0].state!=='skipped')throw new Error('Single-post orchestration did not complete using existing media');
      await jobs.pauseOnStartup();
      if((await store.loadTask(task.id)).state!=='complete')throw new Error('Browser startup must preserve a completed task');
    }finally {chrome.tabs.get=originalGet;chrome.scripting.executeScript=originalExecute;}
    return 'PASS: single-post orchestration completes only after scanning and duplicate-media accounting';
  }));
  const downloadResult = await page.evaluate(async () => {
    const store = await import(chrome.runtime.getURL('src/store.js'));
    const downloads = await import(chrome.runtime.getURL('src/downloads.js'));
    const task = await store.createTask({accountId:'900',viewerId:'901',username:'download_test'},['posts'],{metadata:true});
    await store.saveScanPage(task.id,'posts',{context:task.context,contents:[{id:'902',accountId:'900',username:'download_test',category:'posts',
      publishedAt:null,permalink:'https://www.instagram.com/p/test/',caption:'fixture',media:[{id:'903',index:1,kind:'image',extension:'jpg'}]}],nextCursor:null,terminal:true});
    let item;
    // Claim only metadata: no real Instagram request or media download.
    for(const candidate of await store.loadItems(task.id)) if(candidate.type==='media') await store.updateItem(candidate.id,{state:'skipped'});
    item=await store.claimNext(task.id);
    const destinationStore=await import(chrome.runtime.getURL('src/destination.js'));
    await destinationStore.saveDestination(await (await navigator.storage.getDirectory()).getDirectoryHandle('test',{create:true}));
    const destination=await destinationStore.requireDestination();
    await store.updateTask(task.id,{destination});
    await downloads.startDownload(item);
    const completed=(await store.loadItems(task.id)).find(value=>value.id===item.id);
    if(completed.state!=='succeeded')throw new Error('Direct file write did not persist');
    let folder=destination.handle;const parts=completed.relativePath.split('/');
    for(const part of parts.slice(0,-1))folder=await folder.getDirectoryHandle(part);
    const saved=JSON.parse(await (await (await folder.getFileHandle(parts.at(-1))).getFile()).text());
    if(saved.id!=='902')throw new Error('Saved provenance does not match the post');
    return 'PASS: actual direct JSON write and persisted completion';
  });
  console.log(downloadResult);
  await context.close();
  context = await chromium.launchPersistentContext(profile, {channel:'chromium',headless:true,
    downloadsPath:path.join(profile,'downloads'),
    args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const restartedWorker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker',{timeout:15000});
  const restartedPage = await context.newPage();
  await restartedPage.goto(`chrome-extension://${new URL(restartedWorker.url()).host}/ui/popup.html`);
  await restartedPage.evaluate(async taskId => {
    const store = await import(chrome.runtime.getURL('src/store.js'));
    const task = await store.loadTask(taskId);
    const items = await store.loadItems(taskId);
    if((await store.loadSettings()).root!=='BrowserArchive')throw new Error('Browser restart lost local preferences');
    if (task?.scans.posts.state !== 'complete' || items.length !== 3 || !items.some(item=>item.state==='pending')) {
      throw new Error('Browser restart lost scan checkpoint or pending queue');
    }
  },result.taskId);
  console.log('PASS: task, scan checkpoint and pending queue survive a full browser restart');
} finally {
  await context?.close();
  await rm(profile,{recursive:true,force:true});
}
