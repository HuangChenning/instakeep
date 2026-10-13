(() => {
  const selector='[data-instakeep-download]';
  let scheduled=false;
  function mount() {
    scheduled=false;
    if(!/^\/(?:[A-Za-z0-9_.]+\/)?p\/[A-Za-z0-9_-]+\/?$/.test(location.pathname)) {
      document.querySelectorAll(`${selector},[data-instakeep-status]`).forEach(element=>element.remove());return;
    }
    const action=document.querySelector('svg[aria-label="评论"],svg[aria-label="Comment"]');
    if(!action)return;
    let row=action.parentElement;
    for(let depth=0;row && depth<6;depth++,row=row.parentElement) {
      if(row.querySelector('svg[aria-label="收藏"],svg[aria-label="Save"]'))break;
    }
    if(!row || row.querySelector(selector))return;
    document.querySelectorAll(`${selector},[data-instakeep-status]`).forEach(element=>element.remove());
    const button=document.createElement('button');
    button.type='button';button.dataset.instakeepDownload='';
    button.style.cssText='border:0;background:transparent;color:inherit;cursor:pointer;padding:8px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;';
    button.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/></svg>';
    const label=text=>{button.title=`InstaKeep · ${text}`;button.setAttribute('aria-label',button.title);};
    label('下载全部图片');
    const notice=document.createElement('div');
    notice.dataset.instakeepStatus='';notice.setAttribute('role','status');
    notice.style.cssText='font:12px/1.5 system-ui;padding:4px 8px;color:inherit;';
    const notify=text=>{label(text);notice.textContent=`InstaKeep：${text}`;};
    button.addEventListener('click',async event=>{
      if(!event.isTrusted)return;
      const postPath=location.pathname;
      button.disabled=true;notify('正在读取全部图片…');
      try {
        const response=await chrome.runtime.sendMessage({type:'START_POST_IMAGES'});
        if(!response?.ok)throw Object.assign(new Error(response?.error ?? '扩展未响应，请刷新帖子后重试。'),{code:response?.code});
        const poll=async()=>{
          if(!button.isConnected || location.pathname!==postPath)return;
          const response=await chrome.runtime.sendMessage({type:'GET_POST_STATUS',taskId:responseId});
          if(!response?.ok)throw new Error(response?.error ?? '无法读取下载进度。');
          const status=response.data;
          if(status.state==='complete') {
            notify(`已保存 ${status.saved} 张图片${status.skipped ? `（已有 ${status.skipped} 张，未重复下载）`:''}`);
            button.disabled=false;return;
          }
          if(['paused','incomplete'].includes(status.state)) {
            notify(status.error ?? '下载未完成，请在扩展中恢复或重试。');button.disabled=false;return;
          }
          notify(`下载中：${status.saved}/${status.total} 张图片`);
          setTimeout(()=>poll().catch(error=>{notify(error.message);button.disabled=false;}),1000);
        };
        const responseId=response.data.id;
        await poll();
      }catch(error){
        if(!button.isConnected || location.pathname!==postPath)return;
        notify(error.message);button.disabled=false;
        if(error.code==='DESTINATION_REQUIRED') {
          const authorize=document.createElement('button');authorize.type='button';authorize.textContent='选择或授权保存目录';
          authorize.addEventListener('click',()=>chrome.runtime.sendMessage({type:'OPEN_DESTINATION'}));
          notice.append(' ',authorize);
        }
      }
    });
    row.append(button);row.after(notice);
  }
  const observer=new MutationObserver(()=>{
    if(scheduled)return;scheduled=true;requestAnimationFrame(mount);
  });
  observer.observe(document.documentElement,{childList:true,subtree:true});
  addEventListener('popstate',mount);mount();
})();
