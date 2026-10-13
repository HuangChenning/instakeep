const button = document.querySelector('#check');
const result = document.querySelector('#result');
const inspect = document.querySelector('#inspect');
const evidence = document.querySelector('#evidence');
for (const [id,type] of [['probe-start','PROBE_START'],['probe-status','PROBE_STATUS'],['probe-stop','PROBE_STOP'],['probe-validate','PROBE_VALIDATE'],['probe-read','PROBE_READ']]) {
  const control=document.getElementById(id);
  control.addEventListener('click',async()=>{
    control.disabled=true;
    try {
      const response=await chrome.runtime.sendMessage({type});
      if(!response?.ok)throw new Error(response?.error ?? '扩展未响应。');
      const report=response.data;
      if(type==='PROBE_VALIDATE' || type==='PROBE_READ') {
        evidence.textContent=`当前样本读取验证通过：${report.contents} 条内容，${report.media} 个媒体（图片 ${report.images}，视频 ${report.videos}）；末页标记 ${report.terminal ?? '详情不适用'}。此检查不代表已备份全部主页。`;
        return;
      }
      const lines=[`临时观察：${report.active ? '已开启，请关闭弹窗并向下滚动主页，再回来查看结果':'已停止'}；响应 ${report.responses ?? 0}；解析错误 ${report.errors ?? 0}`,
        ...(report.applicationId ? [`网页公开应用标识：${report.applicationId}`]:[]),
        ...(report.roots ?? []).map(name=>`响应类型：${name}`),
        ...(report.envelopes ?? []).map(item=>`响应结构：${JSON.stringify(item)}`),
        ...(report.requests ?? []).flatMap(item=>Object.entries(item.variables).map(([key,value])=>`查询参数 · ${item.operation} · ${key}：${JSON.stringify(value)}`)),
        ...(report.requests ?? []).filter(item=>item.operation.includes('ProfileReels')).map(item=>`Reels 参数身份：数值 ID ${item.numericId}；与目标 ID 一致 ${item.idMatchesTarget}`),
        ...(report.operations ?? []).map(name=>`页面查询名称：${name}`),
        ...(report.endpoints ?? []).map(path=>`页面请求路径：${path}`),
        ...(report.lists ?? []).map(list=>`分页列表：${list.name}；本页 ${list.count} 条；还有下一页 ${list.hasNext}；游标 ${list.hasCursor}`),
        ...(report.lists ?? []).filter((_,index,items)=>index<2 || index===items.length-1).flatMap((list,index)=>Object.entries(list.node ?? {})
          .map(([key,value])=>`分页内容 ${index+1} · ${key}：${JSON.stringify(value)}`))];
      evidence.replaceChildren(...lines.map(line=>{const row=document.createElement('div');row.textContent=line;return row;}));
    }catch(error){evidence.textContent=error.message;}
    finally{control.disabled=false;}
  });
}
inspect.addEventListener('click', async () => {
  inspect.disabled = true;
  evidence.textContent = '正在检查页面已加载的数据结构…';
  try {
    const response = await chrome.runtime.sendMessage({type:'READ_EVIDENCE'});
    if (!response?.ok) throw new Error(response?.error ?? '扩展未响应，请重新加载后检查。');
    const report = response.data.evidence;
    const lines = [`媒体数据对象：${report.mediaObjects}；扫描截断：${report.truncated}；主页身份匹配：${report.identityMatches}；登录标记：${report.loginMarker}`,
      `JSON 脚本：${report.scripts}；成功解析：${report.parsed}；嵌套 JSON：${report.embeddedJSON}`,
      ...(report.inlineMarkers ?? []).map(item=>`内联数据标记：${JSON.stringify(item)}`),
      ...report.pagination.map(page=>`分页：${JSON.stringify(page)}`),
      ...(report.connections ?? []).flatMap(connection=>[`数据列表：${connection.name}；首屏 ${connection.edges} 条`,
        ...Object.entries(connection.node ?? {}).map(([key,value])=>`列表内容 · ${key}：${JSON.stringify(value)}`)]),
      ...report.shapes.flatMap((sample,index)=>Object.entries(sample).map(([key,value])=>
        `结构 ${index+1} · ${key}：${JSON.stringify(value)}`))];
    evidence.replaceChildren(...lines.map(line=>{const row=document.createElement('div');row.textContent=line;return row;}));
  } catch (error) { evidence.textContent = error.message; }
  finally { inspect.disabled = false; }
});
button.addEventListener('click', async () => {
  button.disabled = true;
  result.textContent = '正在检查…';
  try {
    const response = await chrome.runtime.sendMessage({type:'READ_CONTEXT'});
    if (!response?.ok) throw new Error(response?.error ?? '扩展未响应，请重新加载后检查。');
    result.textContent = `已识别 @${response.data.username}（主页 ID：${response.data.accountId}）。检测到登录标记，登录有效性仍待验证。批量读取仍待验证。`;
  } catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});
const settingsForm=document.getElementById('settings');
const jobMessage=document.getElementById('job-message');
async function send(type,fields={}) {
  const response=await chrome.runtime.sendMessage({type,...fields});
  if(!response?.ok)throw new Error(response?.error ?? '扩展未响应。');
  return response.data;
}
function settingsInput() {
  return Object.fromEntries(['root','folderTemplate','filenameTemplate','metadata'].map(name=>[name,
    name==='metadata' ? settingsForm.elements[name].checked:settingsForm.elements[name].value]));
}
let initialized=false;
async function refreshStatus() {
  try {
    const {task,items,settings,destination}=await send('GET_STATUS');
    document.getElementById('destination-name').textContent=destination ? `保存文件夹：${destination}`:'请先选择保存文件夹。';
    if(!initialized) {
      for(const [name,value] of Object.entries(settings)) {
        if(name==='metadata')settingsForm.elements[name].checked=value;
        else settingsForm.elements[name].value=value;
      }
      initialized=true;
    }
    const labels={scanning:'扫描中',downloading:'下载中',paused:'已暂停',complete:'备份完成',incomplete:'有未解决失败',pending:'待扫描',unknown:'完整性未确认'};
    const media=items.filter(item=>item.type==='media');
    document.getElementById('saved-files').textContent=items.filter(item=>['succeeded','skipped'].includes(item.state) && item.actualPath).map(item=>item.actualPath).join('\n') || '暂无已确认保存的文件。';
    document.getElementById('job-status').textContent=task ? [
      `@${task.context.username} · ${labels[task.state] ?? task.state}`,
      ...Object.entries(task.scans).map(([category,scan])=>`${category==='posts' ? '帖子':'Reels'}：${labels[scan.state] ?? scan.state}`),
      `已读取 ${new Set(items.map(item=>item.contentId)).size} 条内容；${media.length} 个媒体`,
      `媒体：成功 ${media.filter(item=>item.state==='succeeded').length}，重复跳过 ${media.filter(item=>item.state==='skipped').length}，失败/未确认 ${media.filter(item=>['failed','unknown'].includes(item.state)).length}`,
      `来源 JSON：成功 ${items.filter(item=>item.type==='metadata' && item.state==='succeeded').length}`,
      task.reason,...(task.warnings ?? [])].filter(Boolean).join('\n'):'没有当前任务。';
  }catch(error){document.getElementById('job-status').textContent=error.message;}
}
settingsForm.addEventListener('submit',async event=>{
  event.preventDefault();
  try {await send('SAVE_SETTINGS',{settings:settingsInput()});jobMessage.textContent='设置已保存；当前任务仍使用开始时的设置。';}
  catch(error){jobMessage.textContent=error.message;}
});
for(const [id,type] of [['start','START'],['single','START_SINGLE'],['pause','PAUSE'],['resume','RESUME'],['retry','RETRY_FAILED'],['clear-history','CLEAR_HISTORY']]) {
  const control=document.getElementById(id);
  control.addEventListener('click',async()=>{
    if(type==='CLEAR_HISTORY' && !confirm('清除当前任务账号的完成记录？不会删除文件，下次备份会再次下载。'))return;
    control.disabled=true;
    try {
      if(['START','START_SINGLE'].includes(type))await send('SAVE_SETTINGS',{settings:settingsInput()});
      await send(type,['START','START_SINGLE'].includes(type) ? {force:document.getElementById('force').checked}:{});
      jobMessage.textContent=['START','START_SINGLE'].includes(type) ? '任务已开始；关闭弹窗后仍会继续。':'操作已提交。';
      await refreshStatus();
    }catch(error){jobMessage.textContent=error.message;}
    finally{control.disabled=false;}
  });
}
void refreshStatus();
setInterval(refreshStatus,2000);

document.getElementById('destination').addEventListener('click',()=>chrome.tabs.create({url:chrome.runtime.getURL('ui/destination.html')}));
