import { CATEGORIES } from './model.js';
import { DEFAULT_SETTINGS, validateSettings } from './paths.js';
import { makeItems } from './queue.js';
let database;
function settingsValues(input) {
  const values=Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key,value])=>[key,Object.hasOwn(input ?? {},key) ? input[key]:value]));
  const check=validateSettings(values);
  if(!check.valid)throw new Error(check.errors.join(' '));
  return values;
}
export async function loadSettings() {
  const result=await chrome.storage.local.get(['settings','directoryLayoutVersion']);
  if(result.directoryLayoutVersion!==1) {
    const oldDefault=result.settings?.root==='Instagram' && result.settings.folderTemplate==='{username}/{type}';
    const values=settingsValues(oldDefault ? {...result.settings,root:'',folderTemplate:''}:result.settings);
    await chrome.storage.local.set({settings:values,directoryLayoutVersion:1});
    return values;
  }
  return settingsValues(result.settings);
}
export async function saveSettings(input) {
  const values=settingsValues(input);
  await chrome.storage.local.set({settings:values,directoryLayoutVersion:1});
  return values;
}
function request(req) {
  return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
}
async function openStore() {
  if (!database) database = new Promise((resolve,reject)=>{
    const req = indexedDB.open('instakeep',1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('tasks',{keyPath:'id'});
      const items = db.createObjectStore('items',{keyPath:'id'});
      items.createIndex('taskId','taskId');
      items.createIndex('downloadId','downloadId');
      items.createIndex('taskKey',['taskId','mediaKey'],{unique:true});
      db.createObjectStore('completed',{keyPath:'key'}).createIndex('accountId','accountId');
    };
    req.onsuccess=()=>{req.result.onversionchange=()=>{req.result.close();database=null;};resolve(req.result);};
    req.onerror=()=>{database=null;reject(req.error);};
  });
  return database;
}
async function transaction(names,mode,work) {
  const db = await openStore();
  const tx = db.transaction(names,mode);
  const done = new Promise((resolve,reject)=>{
    tx.oncomplete=resolve;
    tx.onabort=()=>reject(tx.error ?? new Error('数据库事务已取消。'));
    tx.onerror=()=>{};
  });
  try {
    const result = await work(Object.fromEntries(names.map(name=>[name,tx.objectStore(name)])));
    await done;
    return result;
  } catch (error) {
    try {tx.abort();} catch { /* May already be aborted. */ }
    await done.catch(()=>{});
    throw error;
  }
}
export async function closeStore() {
  if (database) (await database).close();
  database=null;
}
export async function createTask(context, selectedCategories, settings) {
  const options = {...DEFAULT_SETTINGS,...settings};
  if (!validateSettings(options).valid || !selectedCategories.length
      || selectedCategories.some(category=>!CATEGORIES.includes(category))) throw new Error('任务设置无效。');
  if (!/^\d+$/.test(context.accountId) || !/^\d+$/.test(context.viewerId)) throw new Error('缺少账号上下文。');
  const task = {id:crypto.randomUUID(),context:structuredClone(context),selectedCategories:[...new Set(selectedCategories)],
    settingsSnapshot:structuredClone(options),state:'scanning',createdAt:Date.now(),
    scans:Object.fromEntries(selectedCategories.map(category=>[category,{state:'pending',cursor:null}]))};
  await transaction(['tasks'],'readwrite',async({tasks})=>request(tasks.add(task)));
  return task;
}
export function loadTask(id) {
  return transaction(['tasks'],'readonly',async({tasks})=>request(tasks.get(id)));
}
export function loadTasks() {
  return transaction(['tasks'],'readonly',async({tasks})=>request(tasks.getAll()));
}
export function loadItems(taskId) {
  return transaction(['items'],'readonly',async({items})=>request(items.index('taskId').getAll(taskId)));
}
export async function saveScanPage(taskId,category,page) {
  await transaction(['tasks','items','completed'],'readwrite',async({tasks,items,completed})=>{
    const task = await request(tasks.get(taskId));
    if (!task || !task.selectedCategories.includes(category)) throw new Error('扫描类型与任务不匹配。');
    if (task.context.accountId !== page.context?.accountId || task.context.viewerId !== page.context?.viewerId) {
      throw new Error('账号上下文已变化，必须暂停。');
    }
    if (!Array.isArray(page.contents) || typeof page.terminal !== 'boolean'
        || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new Error('分页格式无效。');
    const previous = task.scans[category];
    const seenCursors=previous.seenCursors ?? (previous.cursor ? [previous.cursor]:[]);
    const repeated = page.nextCursor !== null && seenCursors.includes(page.nextCursor);
    const terminal = page.terminal && page.nextCursor === null;
    task.scans[category]={cursor:page.nextCursor,seenCursors:page.nextCursor!==null && !repeated ? [...seenCursors,page.nextCursor]:seenCursors,
      state:repeated || (page.terminal && !terminal) ? 'unknown' : terminal ? 'complete':'scanning'};
    if(repeated){task.state='paused';task.reason='分页游标循环，完整性未确认。';}
    task.warnings=[...new Set([...(task.warnings ?? []),...page.contents.flatMap(content=>content.media.map(media=>media.qualityNote).filter(Boolean))])];
    for (const item of makeItems(task,page.contents)) {
      if (await request(items.get(item.id))) continue;
      const done = await request(completed.get(item.mediaKey));
      if (done && done.destinationId===task.destination?.id
          && done.relativePath.slice(0,done.relativePath.lastIndexOf('/')+1)===item.relativePath.slice(0,item.relativePath.lastIndexOf('/')+1)
          && !task.settingsSnapshot.force) {item.state='skipped';item.relativePath=done.relativePath;item.actualPath=done.actualPath;}
      await request(items.add(item));
    }
    await request(tasks.put(task));
  });
}
export async function claimNext(taskId) {
  return transaction(['tasks','items'],'readwrite',async({tasks,items})=>{
    const task = await request(tasks.get(taskId));
    if (!task || !['scanning','downloading'].includes(task.state)) return null;
    const list = await request(items.index('taskId').getAll(taskId));
    const item = list.find(item=>{
      if(item.state!=='pending' || item.nextRetryAt>Date.now())return false;
      if(item.type!=='metadata')return true;
      return item.payload.media.every(media=>list.some(candidate=>candidate.mediaKey===`media|${media.id}:${media.index}`
        && ['succeeded','skipped'].includes(candidate.state)));
    });
    if (!item) return null;
    if(item.type==='metadata')item.payload.media=item.payload.media.map(media=>({...media,
      path:(list.find(candidate=>candidate.mediaKey===`media|${media.id}:${media.index}`).actualPath
        ?? list.find(candidate=>candidate.mediaKey===`media|${media.id}:${media.index}`).relativePath)}));
    item.state='starting';item.attempts++;item.startedAt=Date.now();
    await request(items.put(item));
    return item;
  });
}
export async function attachDownload(itemId,downloadId) {
  await transaction(['items'],'readwrite',async({items})=>{
    const item = await request(items.get(itemId));
    if (item?.state!=='starting' || !Number.isInteger(downloadId)) throw new Error('下载关联无效。');
    item.downloadId=downloadId;item.state='downloading';
    await request(items.put(item));
  });
}
export async function markSucceeded(itemId,downloadId,actualRelativePath,actualPath) {
  await transaction(['items','completed'],'readwrite',async({items,completed})=>{
    const item = await request(items.get(itemId));
    if (item?.state!=='downloading' || item.downloadId!==downloadId) throw new Error('成功事件与下载不匹配。');
    item.state='succeeded';
    if (actualRelativePath) item.relativePath=actualRelativePath;
    if(actualPath)item.actualPath=actualPath;
    await request(items.put(item));
    await request(completed.put({key:item.mediaKey,accountId:item.accountId,relativePath:item.relativePath,actualPath:item.actualPath,downloadId}));
  });
}
export async function recordActualPath(itemId,actualPath) {
  await transaction(['items','completed'],'readwrite',async({items,completed})=>{
    const item=await request(items.get(itemId));
    if(item?.state!=='succeeded')return;
    item.actualPath=actualPath;await request(items.put(item));
    const done=await request(completed.get(item.mediaKey));
    if(done?.downloadId===item.downloadId)await request(completed.put({...done,actualPath}));
  });
}
export async function updateItem(itemId,changes) {
  await transaction(['items'],'readwrite',async({items})=>{
    const item=await request(items.get(itemId));
    if (!item) throw new Error('下载项不存在。');
    await request(items.put({...item,...changes,id:item.id,taskId:item.taskId,mediaKey:item.mediaKey}));
  });
}
export async function updateTask(taskId,changes) {
  await transaction(['tasks'],'readwrite',async({tasks})=>{
    const task=await request(tasks.get(taskId));
    if (!task) throw new Error('任务不存在。');
    await request(tasks.put({...task,...changes,id:task.id}));
  });
}
export async function clearAccountHistory(accountId) {
  await transaction(['completed'],'readwrite',async({completed})=>{
    const entries=await request(completed.index('accountId').getAll(accountId));
    for (const entry of entries) await request(completed.delete(entry.key));
  });
}

export function findDownloadItem(downloadId) {
  return transaction(['items'],'readonly',async({items})=>request(items.index('downloadId').get(downloadId)));
}

export async function markFileSucceeded(itemId,relativePath,destination) {
  await transaction(['items','completed'],'readwrite',async({items,completed})=>{
    const item=await request(items.get(itemId));
    if(item?.state!=='starting')throw new Error('写入项状态不匹配。');
    item.state='succeeded';item.relativePath=relativePath;
    item.actualPath=`${destination.name}/${relativePath}`;
    await request(items.put(item));
    await request(completed.put({key:item.mediaKey,accountId:item.accountId,relativePath,actualPath:item.actualPath,destinationId:destination.id}));
  });
}
