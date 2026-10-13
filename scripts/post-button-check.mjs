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
  await page.route('https://www.instagram.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><main><section><button><svg aria-label="评论"></svg></button><button><svg aria-label="收藏"></svg></button></section></main>'}));
  await page.goto('https://www.instagram.com/example/p/TestPost/');
  await page.getByRole('button',{name:'InstaKeep · 下载全部图片',exact:true}).waitFor({timeout:5000});
  if(await page.locator('[data-instakeep-download]').count()!==1)throw new Error('button missing or duplicated');
  await page.evaluate(()=>document.querySelector('section').append(document.createElement('span')));
  if(await page.locator('[data-instakeep-download]').count()!==1)throw new Error('mutation duplicated button');
  await page.evaluate(()=>{history.pushState({},'', '/example/');window.dispatchEvent(new PopStateEvent('popstate'));});
  if(await page.locator('[data-instakeep-download]').count()!==0)throw new Error('profile retained post button');
  console.log('PASS: post action button mounts once, survives rerender and disappears on profile navigation');
}finally{await context?.close();await rm(profile,{recursive:true,force:true});}
