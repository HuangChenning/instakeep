import { handleDownloadChange } from './downloads.js';
import { readContext } from './page-reader.js';
import { pageProbe } from './page-probe.js';
import { normalizeContent, normalizePage } from './instagram.js';
import {prepare,startTask,resumeJob,status,wakeJobs,pauseOnStartup,postStatus} from './jobs.js';
import {pauseTask} from './downloads.js';
import {saveSettings,clearAccountHistory} from './store.js';
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='instakeep-scheduler')wakeJobs().catch(()=>console.error('调度唤醒失败。'));});
chrome.runtime.onStartup.addListener(()=>{pauseOnStartup().catch(()=>console.error('重启暂停失败。'));});
const probeTabs=new Set();
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
  if(change.status!=='loading' || !probeTabs.has(tabId) || !/^https:\/\/(www\.)?instagram\.com\//.test(tab.url ?? ''))return;
  chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:pageProbe,args:['start'],injectImmediately:true})
    .catch(()=>{probeTabs.delete(tabId);console.error('页面重新加载后诊断未启动，请重新开启临时观察。');});
});
chrome.tabs.onRemoved.addListener(tabId=>probeTabs.delete(tabId));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if(['START_POST_IMAGES','GET_POST_STATUS','OPEN_DESTINATION'].includes(message?.type)) {
    if(sender.id!==chrome.runtime.id || sender.frameId!==0 || !Number.isInteger(sender.tab?.id)
        || !/^https:\/\/(?:www\.)?instagram\.com\//.test(sender.url ?? '')
        || JSON.stringify(message).length>150)return;
    (async()=>{
      const tab=await chrome.tabs.get(sender.tab.id);
      if(!/^https:\/\/(?:www\.)?instagram\.com\//.test(tab.url ?? ''))throw new Error('请先打开 Instagram。');
      if(message.type==='OPEN_DESTINATION') {
        await chrome.tabs.create({url:chrome.runtime.getURL('ui/destination.html')});return {};
      }
      if(message.type==='GET_POST_STATUS')return postStatus(message.taskId,tab.id);
      const postPath=message.postPath ?? new URL(tab.url).pathname;
      if(!/^\/(?:[A-Za-z0-9_.]+\/)?p\/[A-Za-z0-9_-]+\/?$/.test(postPath))throw new Error('帖子地址无效。');
      return {id:await startTask(tab.id,['posts'],false,true,true,postPath)};
    })().then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message,code:error.code}));
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('ui/popup.html')
      || !['READ_CONTEXT','READ_EVIDENCE','PROBE_START','PROBE_STATUS','PROBE_STOP','PROBE_VALIDATE','PROBE_READ','START','START_SINGLE','PAUSE','RESUME','RETRY_FAILED','GET_STATUS','SAVE_SETTINGS','CLEAR_HISTORY'].includes(message?.type)
      || JSON.stringify(message).length>4000) return;
  (async () => {
    if(message.type==='GET_STATUS'){respond({ok:true,data:await status()});return;}
    if(message.type==='SAVE_SETTINGS'){respond({ok:true,data:await saveSettings(message.settings)});return;}
    if(['PAUSE','CLEAR_HISTORY'].includes(message.type)) {
      const current=await status();
      if(!current.task)throw new Error('没有当前任务。');
      if(message.type==='PAUSE')await pauseTask(current.task.id);
      else await clearAccountHistory(current.task.context.accountId);
      respond({ok:true,data:{}});return;
    }
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (!tab?.id || !/^https:\/\/(www\.)?instagram\.com\//.test(tab.url ?? '')) {
      throw new Error('请先打开 Instagram 用户主页。');
    }
    if(['START','START_SINGLE','RESUME','RETRY_FAILED'].includes(message.type)) {
      if(['START','START_SINGLE'].includes(message.type))await startTask(tab.id,['posts'],message.force ?? false,message.type==='START_SINGLE');
      else {
        const current=await status();
        if(!current.task)throw new Error('没有可恢复的任务。');
        await resumeJob(current.task.id,tab.id,message.type==='RETRY_FAILED');
      }
      respond({ok:true,data:{}});return;
    }
    const probeAction={PROBE_START:'start',PROBE_STATUS:'status',PROBE_STOP:'stop',PROBE_VALIDATE:'sample',PROBE_READ:{type:'read-posts',cursor:null}}[message.type];
    if(probeAction==='start')probeTabs.add(tab.id);
    if(probeAction==='stop')probeTabs.delete(tab.id);
    const [result] = await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',
      func:probeAction ? pageProbe:readContext,args:[probeAction ?? (message.type==='READ_EVIDENCE')]});
    if (!result?.result) throw new Error('无法读取当前主页，请重新打开扩展后检查。');
    const current = await chrome.tabs.get(tab.id);
    if (current.url !== tab.url) throw new Error('页面已变化，请重新检查主页。');
    if(probeAction==='sample' || message.type==='PROBE_READ') {
      if(result.result.error)throw new Error(result.result.error);
      const page=result.result.detail ? {contents:[normalizeContent(result.result.detail,result.result.context,'reels')],terminal:null}
        :normalizePage(result.result.response,result.result.context,result.result.category);
      if(message.type==='PROBE_READ' && !page.terminal) {
        const [next]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:pageProbe,
          args:[{type:'read-posts',cursor:page.nextCursor}]});
        if(next?.result?.error)throw new Error(next.result.error);
        if(!next?.result || (await chrome.tabs.get(tab.id)).url!==tab.url)throw new Error('读取过程中页面变化。');
        const nextPage=normalizePage(next.result.response,result.result.context,'posts',page.nextCursor);
        const ids=new Set(page.contents.map(content=>content.id));
        if(nextPage.contents.some(content=>ids.has(content.id)))throw new Error('分页返回重复内容，完整性未确认。');
        page.contents.push(...nextPage.contents);page.terminal=nextPage.terminal;
      }
      const media=page.contents.flatMap(content=>content.media);
      respond({ok:true,data:{contents:page.contents.length,media:media.length,images:media.filter(item=>item.kind==='image').length,
        videos:media.filter(item=>item.kind==='video').length,terminal:page.terminal}});
      return;
    }
    if(message.type==='PROBE_STATUS')await prepare(tab.id).catch(()=>{});
    if(probeAction) {respond({ok:true,data:result.result});return;}
    respond({ok:true,data:{username:result.result.username,accountId:result.result.accountId,
      ...(message.type==='READ_EVIDENCE' ? {evidence:result.result.evidence}:{})}});
  })().catch(error => respond({ok:false,error:error.message}));
  return true;
});

chrome.downloads.onChanged.addListener(change => {handleDownloadChange(change).then(wakeJobs).catch(() => console.error('下载状态保存失败，请重新检查任务。'));});
