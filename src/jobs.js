import {loadDestination,requireDestination} from './destination.js';
import {readSource} from './source.js';
import {pageProbe} from './page-probe.js';
import {normalizePage,normalizeContent} from './instagram.js';
import {createTask,loadTask,loadTasks,loadItems,saveScanPage,updateTask,loadSettings} from './store.js';
import {pump,reconcile,resumeTask,retryFailed,pauseTask} from './downloads.js';
import {completion} from './model.js';
const running=new Set();
export async function prepare(tabId) {
  const [result]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:pageProbe,args:['source']});
  const source=result?.result;
  if(!source || source.error)throw new Error(source?.error ?? '请先准备主页读取。');
  const {queries={}}=await chrome.storage.local.get('queries');
  await chrome.storage.local.set({queries:{...queries,...source.queries},...(source.appId ? {appId:source.appId}:{})});
  return source.context;
}
async function sourceCall(task,category,cursor,contentId=null) {
  const tab=await chrome.tabs.get(task.tabId);
  const url=new URL(tab.url);
  if(url.protocol!=='https:' || !['www.instagram.com','instagram.com'].includes(url.hostname)
      || !(task.context.postCode ? url.pathname===(task.context.sourcePath ?? task.context.postPath)
        :[`/${task.context.username}/`,`/${task.context.username}/reels/`].includes(url.pathname))) {
    throw new Error('目标主页已关闭或变化，请重新打开后恢复。');
  }
  const {queries={},appId}=await chrome.storage.local.get(['queries','appId']);
  const [result]=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:readSource,
    args:[{category,query:queries[category],context:task.context,cursor,contentId,appId}]});
  if(!result?.result || result.result.error)throw Object.assign(new Error(result?.result?.error ?? '页面读取失败。'),{code:result?.result?.code});
  return result.result;
}
async function refreshMedia(taskId,context,contentId,mediaId) {
  const task=await loadTask(taskId);
  const result=await sourceCall(task,'posts',null,contentId);
  const content=normalizeContent(result.detail,context,'posts');
  const media=content.media.find(item=>item.id===mediaId);
  if(!media)throw new Error('媒体清单已变化。');
  return media;
}
export async function runTask(taskId) {
  if(running.has(taskId))return;
  running.add(taskId);
  const freshMedia=new Map();
  try {
    let task=await loadTask(taskId);
    if(!task || !Number.isInteger(task.tabId) || !['scanning','downloading'].includes(task.state))return;
    for(const category of task.selectedCategories) {
      while(task.scans[category].state!=='complete') {
        if(!['scanning','downloading'].includes(task.state))return;
        const cursor=task.scans[category].cursor;
        const result=await sourceCall(task,category,cursor,task.singleContentId ?? null);
        const page=task.singleContentId ? {contents:[normalizeContent(result.detail,task.context,'posts')],context:task.context,nextCursor:null,terminal:true}
          :normalizePage(result.response,task.context,category,cursor);
        if(task.imagesOnly)page.contents=page.contents.map(content=>({...content,media:content.media.filter(media=>media.kind==='image')}));
        for(const content of page.contents)for(const media of content.media)freshMedia.set(`${content.id}:${media.id}`,media);
        task=await loadTask(taskId);
        if(task.state==='paused')return;
        await saveScanPage(taskId,category,page);
        task=await loadTask(taskId);
        if(task.state==='paused')return;
        if(!page.terminal)await new Promise(resolve=>setTimeout(resolve,2000));
      }
    }
    if((await loadTask(taskId)).state==='paused')return;
    await updateTask(taskId,{state:'downloading',reason:null});
    await pump(taskId,(context,contentId,mediaId)=>freshMedia.get(`${contentId}:${mediaId}`) ?? refreshMedia(taskId,context,contentId,mediaId));
    task=await loadTask(taskId);
    const items=await loadItems(taskId);
    if(task.state==='paused')return;
    const state=completion(task,items)==='complete' ? 'complete'
      :items.some(item=>['failed','unknown'].includes(item.state)) && !items.some(item=>['pending','starting','downloading'].includes(item.state)) ? 'incomplete':'downloading';
    await updateTask(taskId,{state});
  }catch(error) {
    await pauseTask(taskId,error.message ?? '读取失败，完整性未确认。');
  }finally {running.delete(taskId);}
}
export async function startTask(tabId,categories,force=false,single=false,imagesOnly=false,singlePath=null) {
  if(!Array.isArray(categories) || !categories.length || categories.some(category=>category!=='posts') || typeof force!=='boolean')throw new Error('当前仅支持帖子。');
  if(imagesOnly && !single)throw new Error('图片按钮仅支持单个帖子。');
  if(singlePath!==null && !single)throw new Error('帖子路径只能用于单帖任务。');
  if((await loadTasks()).some(task=>['scanning','downloading'].includes(task.state)))throw new Error('请先暂停当前任务。');
  const destination=await requireDestination();
  let context;
  let detail;
  if(single) {
    const {appId}=await chrome.storage.local.get('appId');
    const [result]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:readSource,
      args:[{category:'posts',single:true,singlePath,appId}]});
    if(!result?.result || result.result.error)throw new Error(result?.result?.error ?? '帖子详情读取失败。');
    context=result.result.context;detail=normalizeContent(result.result.detail,context,'posts');
    if(imagesOnly && !detail.media.some(media=>media.kind==='image'))throw new Error('这个帖子没有可下载的图片。');
  }else context=await prepare(tabId);
  const {queries={}}=await chrome.storage.local.get('queries');
  if(!single && categories.some(category=>!queries[category]))throw new Error('请准备帖子：开启观察、刷新主页并向下滚动一次，再查看准备结果。');
  const task=await createTask(context,categories,{...await loadSettings(),force});
  await updateTask(task.id,{tabId,destination,imagesOnly,...(single ? {singleContentId:detail.id}:{})});
  await chrome.storage.local.set({activeTaskId:task.id});
  await chrome.alarms.create('instakeep-scheduler',{periodInMinutes:0.5});
  void runTask(task.id);
  return task.id;
}
export function validateResumeState(task,retry) {
  if(!task)throw new Error('没有可恢复的任务。');
  if(task.state==='downloading' || task.state==='scanning')throw new Error('任务正在下载，无需恢复。');
  if(task.state==='complete')throw new Error('任务已经完成，无需恢复。');
  if(!retry && task.state==='incomplete')throw new Error('任务有未解决失败，请使用“重试失败项”。');
  if(!['paused',...(retry ? ['incomplete']:[])].includes(task.state))throw new Error('当前任务状态不能恢复。');
}
export async function resumeJob(taskId,tabId,retry=false) {
  const task=await loadTask(taskId);
  validateResumeState(task,retry);
  if(task?.selectedCategories.some(category=>category!=='posts'))throw new Error('当前仅支持帖子，请新建帖子任务。');
  const destination=await requireDestination(task.destination);
  let context;
  if(task?.singleContentId) {
    const {appId}=await chrome.storage.local.get('appId');
    const [result]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:readSource,
      args:[{category:'posts',single:true,singlePath:task.context.postPath,appId}]});
    if(!result?.result || result.result.error || result.result.context?.postCode!==task.context.postCode
        || result.result.context?.sourcePath!==(task.context.sourcePath ?? task.context.postPath))throw new Error('请重新打开原帖所在页面后恢复。');
    context=result.result.context;
  }else context=await prepare(tabId);
  await resumeTask(taskId,context);
  await updateTask(taskId,{tabId,destination});
  if(retry)await retryFailed(taskId);
  await chrome.alarms.create('instakeep-scheduler',{periodInMinutes:0.5});
  void runTask(taskId);
}
export async function status() {
  const {activeTaskId}=await chrome.storage.local.get('activeTaskId');
  const task=activeTaskId ? await loadTask(activeTaskId):null;
  return {task,items:task ? (await loadItems(task.id)).map(({state,type,contentId,actualPath})=>({state,type,contentId,actualPath})):[],settings:await loadSettings(),destination:(await loadDestination())?.name ?? null};
}
export async function wakeJobs() {
  for(const task of await loadTasks())if(['scanning','downloading'].includes(task.state))void runTask(task.id);
}
export async function pauseOnStartup() {
  for(const task of await loadTasks())if(['scanning','downloading'].includes(task.state)) {
    await pauseTask(task.id,'浏览器已重启；请打开目标主页并手动恢复。');
    await reconcile(task.id);
  }
}

export async function postStatus(taskId,tabId) {
  if(typeof taskId!=='string' || !/^[0-9a-f-]{36}$/.test(taskId))throw new Error('任务标识无效。');
  const task=await loadTask(taskId);
  if(!task || task.tabId!==tabId || !task.singleContentId)throw new Error('任务不属于当前帖子标签页。');
  const items=await loadItems(taskId);
  const media=items.filter(item=>item.type==='media');
  return {state:task.state,total:media.length,saved:media.filter(item=>['succeeded','skipped'].includes(item.state)).length,
    skipped:media.filter(item=>item.state==='skipped').length,
    error:task.reason ?? items.find(item=>['failed','unknown'].includes(item.state))?.error ?? null};
}
