import {requireDestination,writeFile} from './destination.js';
import { loadItems, loadTask, claimNext, attachDownload, markSucceeded, markFileSucceeded, recordActualPath, updateItem, updateTask, findDownloadItem } from './store.js';
const active = new Set();
export function retryPolicy(reason,attempts) {
  const delays=[2000,5000,15000];
  return reason?.startsWith('NETWORK_') && attempts>=1 && attempts<=delays.length
    ? {retry:true,delay:delays[attempts-1]} : {retry:false,delay:0};
}
export function recoveredState(item,record) {
  if (!Number.isInteger(item.downloadId) || !record || item.downloadId!==record.id) return 'unknown';
  return record.state==='complete' ? 'succeeded' : record.state==='in_progress' ? 'downloading' : 'failed';
}
export function downloadOptions(item,url) {
  if (typeof item.relativePath!=='string' || !item.relativePath || /^[\/\\]|^[a-z]:/i.test(item.relativePath)
      || /[\\\u0000-\u001f]/.test(item.relativePath) || item.relativePath.split('/').some(value=>value==='..'||value==='.'||!value)) {
    throw new Error('下载路径必须是下载目录中的相对路径。');
  }
  if (item.type==='metadata') {
    const json=JSON.stringify(item.payload,null,2);
    if (!json || json.length>2000000) throw new Error('来源信息大小异常。');
    url=`data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  } else {
    const parsed=new URL(url);
    if (parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.port
        || !['cdninstagram.com','fbcdn.net'].some(domain=>parsed.hostname===domain || parsed.hostname.endsWith(`.${domain}`))) {
      throw new Error('媒体地址必须来自 Instagram 媒体域名。');
    }
  }
  return {url,filename:item.relativePath,conflictAction:'uniquify',saveAs:false};
}
export async function startDownload(item,url) {
  const options=downloadOptions(item,url);
  const task=await loadTask(item.taskId);
  const destination=await requireDestination(task.destination);
  let body;
  if(item.type==='metadata')body=JSON.stringify(item.payload,null,2);
  else {
    let response;
    try {response=await fetch(options.url,{credentials:'omit',redirect:'error'});}
    catch(error){throw Object.assign(error,{code:'NETWORK_FAILED'});}
    if(response.status===429)throw Object.assign(new Error('媒体访问限流，请稍后恢复。'),{code:'RATE_LIMITED'});
    if([401,403].includes(response.status))throw Object.assign(new Error('媒体访问被拒绝，请检查登录状态后恢复。'),{code:'LOGIN_REQUIRED'});
    if(response.status>=500)throw Object.assign(new Error('媒体服务器暂时不可用。'),{code:'NETWORK_SERVER'});
    const mime=response.headers.get('content-type') ?? '';
    const expected=item.relativePath.endsWith('.mp4') ? /^video\/mp4(?:;|$)/:/^image\/(jpeg|png|webp|avif)(?:;|$)/;
    if(!response.ok || !expected.test(mime) || !response.body)throw new Error('媒体请求失败或文件类型未确认。');
    body=response.body;
  }
  const path=await writeFile(destination.handle,item.relativePath,body);
  await markFileSucceeded(item.id,path,destination);
}

async function applyRecord(item,record) {
  item={...item,downloadId:item.downloadId ?? record.id};
  const state=recoveredState(item,record);
  if(state==='succeeded') {
    const expected=item.type==='metadata' ? /^application\/json(?:;|$)/ : /^(image\/(jpeg|png|webp|avif)|video\/mp4)(?:;|$)/;
    if(!expected.test(record.mime ?? '')) {
      await updateItem(item.id,{state:'failed',error:'下载文件类型未确认，不能作为备份成功。'});
      return;
    }
    const basename=record.filename.replace(/\\/g,'/').split('/').pop();
    const folder=item.relativePath.slice(0,item.relativePath.lastIndexOf('/')+1);
    await markSucceeded(item.id,record.id,`${folder}${basename}`,record.filename);
  } else if(state==='failed') {
    const policy=retryPolicy(record.error,item.attempts);
    await updateItem(item.id,{state:policy.retry?'pending':'failed',downloadId:null,
      nextRetryAt:Date.now()+policy.delay,error:record.error ?? '下载中断。'});
    if(['SERVER_UNAUTHORIZED','SERVER_FORBIDDEN'].includes(record.error)) await pauseTask(item.taskId,'访问被拒绝，请检查登录或限流状态。');
  } else if(state==='unknown') await updateItem(item.id,{state,error:'无法确认下载关联，等待手动重试。'});
}
export async function reconcile(taskId) {
  for(const item of await loadItems(taskId)) {
    if(item.state==='succeeded' && !item.actualPath && Number.isInteger(item.downloadId)) {
      const [record]=await chrome.downloads.search({id:item.downloadId});
      if(record?.state==='complete')await recordActualPath(item.id,record.filename);
    }
    if(!['starting','downloading'].includes(item.state))continue;
    const [record]=Number.isInteger(item.downloadId)?await chrome.downloads.search({id:item.downloadId}):[];
    await applyRecord(item,record ?? {});
  }
  if((await loadTask(taskId))?.destination)return;
  const list=await loadItems(taskId);
  for(const item of list)if(item.type==='metadata' && item.state==='succeeded' && item.payload.media.some(media=>{
    const actual=list.find(candidate=>candidate.mediaKey===`media|${media.id}:${media.index}`)?.actualPath;
    return actual && media.path!==actual;
  }))await updateItem(item.id,{state:'pending',downloadId:null,error:null});
}
export async function handleDownloadChange(change) {
  if(!change.state && !change.error) return;
  const item=await findDownloadItem(change.id);
  if(!item || item.state!=='downloading')return;
  const [record]=await chrome.downloads.search({id:change.id});
  if(record)await applyRecord(item,record);
}
export function pauseTask(taskId,reason='用户暂停。') {return updateTask(taskId,{state:'paused',reason});}
export async function resumeTask(taskId,context) {
  const task=await loadTask(taskId);
  if(!task || context.accountId!==task.context.accountId || context.viewerId!==task.context.viewerId) throw new Error('账号上下文已变化，不能恢复任务。');
  await reconcile(taskId);
  await updateTask(taskId,{state:'downloading',reason:null});
}
export async function retryFailed(taskId) {
  for(const item of await loadItems(taskId)) {
    if(!['failed','unknown'].includes(item.state))continue;
    if(Number.isInteger(item.downloadId)) {
      const [record]=await chrome.downloads.search({id:item.downloadId});
      if(record?.state==='in_progress')throw new Error('旧下载仍在运行，不能重复启动。');
    }
    await updateItem(item.id,{state:'pending',downloadId:null,attempts:0,nextRetryAt:0,error:null});
  }
}
export async function runPool(limit,claim,work) {
  if(!Number.isInteger(limit) || limit<0)throw new Error('并行下载数量无效。');
  await Promise.all(Array.from({length:limit},async()=>{
    for(;;) {
      const item=await claim();
      if(!item)return;
      await work(item);
    }
  }));
}
export async function pump(taskId,refreshMedia) {
  if(active.has(taskId))return;
  active.add(taskId);
  try {
    await reconcile(taskId);
    const items=await loadItems(taskId);
    const slots=2-items.filter(item=>['starting','downloading'].includes(item.state)).length;
    const limit=(await loadTask(taskId)).destination ? 2:Math.max(0,slots);
    await runPool(limit,()=>claimNext(taskId),async item=>{
      try {
        const task=await loadTask(taskId);
        const media=item.type==='media'?await refreshMedia(task.context,item.contentId,item.media.id):null;
        if((await loadTask(taskId)).state==='paused') {await updateItem(item.id,{state:'pending'});return;}
        await startDownload(item,media?.url);
      } catch(error) {
        const fresh=(await loadItems(taskId)).find(value=>value.id===item.id);
        if(fresh?.state==='starting') {
          const policy=retryPolicy(error.code,item.attempts);
          await updateItem(item.id,{state:policy.retry?'pending':'failed',nextRetryAt:Date.now()+policy.delay,error:error.message});
        }
        if(error.name==='NotAllowedError' || error.message.includes('保存目录页面'))await pauseTask(taskId,'保存目录写入权限失效，请重新授权后恢复。');
        if(['LOGIN_REQUIRED','RATE_LIMITED','CONTEXT_CHANGED'].includes(error.code)) await pauseTask(taskId,'登录、访问限制或主页上下文发生变化。');
      }
    });
  } finally {active.delete(taskId);}
}
