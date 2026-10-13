import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH ?? 'playwright');
const root=path.resolve(import.meta.dirname,'..');
const profile=await mkdtemp(path.join(tmpdir(),'instakeep-post-test-'));
let context;
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  const worker=context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin=`chrome-extension://${new URL(worker.url()).host}`;
  const inspector=await context.newPage();await inspector.goto(`${origin}/ui/destination.html`);
  await inspector.evaluate(async()=>{
    const {saveDestination}=await import('../src/destination.js');
    await saveDestination(await (await navigator.storage.getDirectory()).getDirectoryHandle('backup',{create:true}));
  });
  await worker.evaluate(()=>{globalThis.popupCalls=0;chrome.runtime.onMessage.addListener((message,sender)=>{if(message.type==='START_POST_IMAGES')globalThis.lastSender={url:sender.url,tab:sender.tab?.url,origin:sender.origin,frameId:sender.frameId};});chrome.action.openPopup=async()=>{globalThis.popupCalls++;};});
  await context.addCookies([{name:'ds_user_id',value:'200',domain:'.instagram.com',path:'/',secure:true}]);
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const code='TestPost';const id=[...code].reduce((value,char)=>value*64n+BigInt(alphabet.indexOf(char)),0n).toString();
  const image=pk=>({pk,media_type:1,image_versions2:{candidates:[{url:`https://image.example.cdninstagram.com/${pk}.jpg`,width:100,height:100}]}});
  const post={pk:id,code,user:{pk:'100',username:'example'},taken_at:1790812800,media_type:8,carousel_media_count:2,carousel_media:[image('301'),image('302')]};
  await inspector.evaluate(async post=>{
    const store=await import('../src/store.js');const {normalizeContent}=await import('../src/instagram.js');
    const {requireDestination,writeFile}=await import('../src/destination.js');const destination=await requireDestination();
    const context={accountId:'100',viewerId:'200',username:'example'};
    const previous=await store.createTask(context,['posts'],{root:'Instagram',folderTemplate:'{username}/{type}',metadata:true});
    await store.updateTask(previous.id,{destination});
    await store.saveScanPage(previous.id,'posts',{context,contents:[normalizeContent(post,context,'posts')],nextCursor:null,terminal:true});
    for(;;){const item=await store.claimNext(previous.id);if(!item)break;const body=item.type==='media' ? new Uint8Array([255,216,255,217]):JSON.stringify(item.payload);const path=await writeFile(destination.handle,item.relativePath,body);await store.markFileSucceeded(item.id,path,destination);}
    await store.updateTask(previous.id,{state:'complete'});
  },post);
  await context.route('https://**/*',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.includes('/api/v1/media/'))return route.request().headers()['x-ig-app-id']==='936619743392459'
      ? route.fulfill({contentType:'application/json',body:JSON.stringify({items:[post]})})
      : route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'missing public app id'})});
    if(url.hostname.endsWith('cdninstagram.com'))return route.fulfill({contentType:'image/jpeg',body:Buffer.from([255,216,255,217])});
    if(url.hostname==='www.instagram.com')return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><script type="application/json">["JSErrorLoggingConfig",[],{"appId":936619743392459}]</script><main><section><button><svg aria-label="评论"></svg></button><button><svg aria-label="收藏"></svg></button></section></main>'});
    return route.continue();
  });
  const page=await context.newPage();await page.goto('https://www.instagram.com/example/');
  await page.evaluate(code=>{history.pushState({},'',`/example/p/${code}/`);window.dispatchEvent(new PopStateEvent('popstate'));},code);
  const button=page.getByRole('button',{name:'InstaKeep · 下载全部图片',exact:true});
  await button.click({timeout:5000});
  for(let attempt=0;attempt<40;attempt++){
    const state=await inspector.evaluate(async()=>{
      const {activeTaskId}=await chrome.storage.local.get('activeTaskId');
      return activeTaskId ? (await import('../src/store.js')).loadTask(activeTaskId):null;
    });
    if(state?.state==='complete')break;
    if(attempt===39){console.log(await worker.evaluate(()=>globalThis.lastSender));console.log(await page.getByRole('status').textContent());throw new Error('Post click did not complete the media task');}
    await page.waitForTimeout(100);
  }
  if(await worker.evaluate(()=>globalThis.popupCalls)!==0)throw new Error('Post click still opens the settings popup');
  await page.getByRole('status').filter({hasText:'已保存 2 张图片'}).waitFor({timeout:5000});
  await inspector.evaluate(async()=>{const {activeTaskId}=await chrome.storage.local.get('activeTaskId');const items=await (await import('../src/store.js')).loadItems(activeTaskId);if(items.filter(item=>item.type==='media' && item.state==='succeeded').length!==2)throw new Error('Initial click did not save both images');});
  await page.locator('[data-instakeep-download]').click();
  await page.getByRole('status').filter({hasText:'已有 2 张'}).waitFor({timeout:5000});
  console.log(await inspector.evaluate(async()=>{
    const {activeTaskId}=await chrome.storage.local.get('activeTaskId');
    const store=await import('../src/store.js');const task=await store.loadTask(activeTaskId);const items=await store.loadItems(activeTaskId);
    if(items.some(item=>item.relativePath.includes('/')))throw new Error('Default downloads created unexpected subfolders');
    if(task.state!=='complete' || items.filter(item=>item.type==='media' && ['succeeded','skipped'].includes(item.state)).length!==2)throw new Error('Not all carousel images saved');
    for(const item of items){let dir=task.destination.handle;const parts=item.relativePath.split('/');for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part);if(!(await (await dir.getFileHandle(parts.at(-1))).getFile()).size)throw new Error('Empty saved file');}
    return 'PASS: real content-script click -> background -> image stream -> files, inline completion and no popup';
  }));
  await inspector.evaluate(()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open('instakeep-destination',1);
    request.onsuccess=()=>{const db=request.result;const tx=db.transaction('settings','readwrite');tx.objectStore('settings').delete('destination');tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};
  }));
  await page.locator('[data-instakeep-download]').click();
  await page.getByRole('status').filter({hasText:'保存目录需要授权'}).waitFor({timeout:5000});
  const directoryPage=context.waitForEvent('page');
  await page.getByRole('button',{name:'选择或授权保存目录',exact:true}).click();
  const opened=await directoryPage;await opened.waitForLoadState();
  if(opened.url()!==`${origin}/ui/destination.html`)throw new Error('Authorization link did not open extension directory page');
  if(await worker.evaluate(()=>globalThis.popupCalls)!==0)throw new Error('Error path opened popup');
  console.log('PASS: profile-to-post navigation, repeat click deduplication, visible missing-directory error and authorization action');
}finally{await context?.close();await rm(profile,{recursive:true,force:true});}
