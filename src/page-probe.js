// Serialized into the page. Reports structure only; an allowed media sample stays in memory until stopped.
export function pageProbe(action) {
  if (location.protocol!=='https:' || !['www.instagram.com','instagram.com'].includes(location.hostname)) throw new Error('仅支持 Instagram 页面。');
  const key=Symbol.for('instakeep.structureProbe');
  if(action?.type==='read-posts')return window[key]?.readPosts(action.cursor) ?? {code:'READER_NOT_READY',error:'请先开启观察并加载一页帖子分页。'};
  if(action==='source')return window[key]?.source() ?? {error:'请先开启读取准备并加载主页分页。'};
  if(action==='sample')return window[key]?.sample?.() ?? {error:'尚未捕获当前主页的帖子分页，请开启观察并滚动主页。'};
  if (action==='status') {
    const report=window[key]?.report ?? {active:false,responses:0,lists:[],errors:0};
    const endpoints=typeof performance==='undefined' ? [] : performance.getEntriesByType('resource').flatMap(entry=>{
      try {const url=new URL(entry.name);return url.origin===location.origin && /^\/(?:api|graphql)/.test(url.pathname)
        ? [url.pathname.replace(/\/\d+(?=\/|$)/g,'/:id')]:[];} catch {return [];}
    });
    return {...report,applicationId:window[key]?.source()?.appId ?? null,endpoints:[...new Set(endpoints)].slice(0,20)};
  }
  if (action==='stop') {
    window[key]?.stop();
    return {active:false};
  }
  if (action!=='start') throw new Error('未知诊断操作。');
  if (window[key]) return window[key].report;
  const report={active:true,responses:0,lists:[],errors:0,roots:[],operations:[],envelopes:[],requests:[]};
  let sample=null;
  let postsTemplate=null;
  let reelsTemplate=null;
  let appId=null;
  const targetUsername=location.pathname.split('/').filter(Boolean)[0];
  const originalFetch=window.fetch;
  const originalOpen=XMLHttpRequest.prototype.open;
  const originalSend=XMLHttpRequest.prototype.send;
  const originalSetHeader=XMLHttpRequest.prototype.setRequestHeader;
  const xhrHeaders=new WeakMap();
  const xhrListeners=new WeakMap();
  const xhrPaths=new WeakMap();
  const fields=new Set(['id','pk','code','media_type','product_type','user','username','taken_at','caption','text',
    'carousel_media','carousel_media_count','image_versions2','candidates','video_versions','url','width','height','media','original_width','original_height']);
  function project(value,depth=0) {
    if(depth>6)return null;
    if(Array.isArray(value))return value.slice(0,100).map(child=>project(child,depth+1));
    if(!value || typeof value!=='object')return value;
    return Object.fromEntries(Object.entries(value).filter(([name])=>fields.has(name)).map(([name,child])=>[name,project(child,depth+1)]));
  }
  function shape(value,depth=0) {
    if(value===null)return 'null';
    if(Array.isArray(value))return {length:value.length,item:value.length && depth<5 ? shape(value[0],depth+1):'array'};
    if(typeof value!=='object' || depth>=5)return typeof value;
    return Object.fromEntries(Object.entries(value).filter(([name])=>fields.has(name)).map(([name,child])=>[name,shape(child,depth+1)]));
  }
  function schema(value,depth=0) {
    if(value===null)return 'null';
    if(Array.isArray(value))return {length:value.length,item:depth<4 ? schema(value[0],depth+1):'array'};
    if(typeof value!=='object' || depth>=4)return typeof value;
    return Object.fromEntries(Object.entries(value).filter(([name])=>/^[a-zA-Z_][a-zA-Z0-9_]{0,149}$/.test(name))
      .slice(0,30).map(([name,child])=>[name,schema(child,depth+1)]));
  }
  function eligible(input) {
    try {const url=new URL(typeof input==='string' ? input : input.url,location.href);
      return url.origin===location.origin && (['/graphql/query','/graphql/query/','/api/graphql'].includes(url.pathname) || url.pathname.startsWith('/api/v1/'));
    } catch {return false;}
  }
  function mediaRequest(input,body,headers) {
    if(!eligible(input))return false;
    const publicId=headers?.get?.('X-IG-App-ID') ?? headers?.['X-IG-App-ID'] ?? headers?.['x-ig-app-id'];
    if(typeof publicId==='string' && /^\d{1,30}$/.test(publicId))appId=publicId;
    const url=new URL(typeof input==='string' ? input:input.url,location.href);
    if(url.pathname.startsWith('/api/v1/'))return /^\/api\/v1\/(?:feed\/(?:user|reels_media)\/|media\/\d+\/info\/|clips\/user\/|highlights\/\d+\/highlights_tray\/)/.test(url.pathname);
    let operation=typeof body==='string' ? body.match(/(?:^|&)fb_api_req_friendly_name=([^&]+)/)?.[1] : body?.get?.('fb_api_req_friendly_name');
    operation=operation ?? headers?.get?.('X-FB-Friendly-Name') ?? headers?.['X-FB-Friendly-Name'];
    try {operation=decodeURIComponent(operation ?? '');}catch{return false;}
    if(/^[a-zA-Z0-9_]{1,150}$/.test(operation) && !report.operations.includes(operation) && report.operations.length<20)report.operations.push(operation);
    const media=/^Polaris.*(?:ProfilePosts|ProfileReels|ClipsTab|Stories|Story|Highlights)/.test(operation);
    if(media && report.requests.length<8) {
      try {
        const variables=typeof body==='string' ? new URLSearchParams(body).get('variables'):body?.get?.('variables');
        const parsed=JSON.parse(variables ?? '{}');
        report.requests.push({operation,variables:schema(parsed),idMatchesTarget:parsed.id===parsed.data?.target_user_id,
          numericId:typeof parsed.id==='string' && /^\d+$/.test(parsed.id)});
      }catch { /* An unsupported request body cannot seed an automated reader. */ }
    }
    if(operation==='PolarisProfilePostsTabContentQuery_connection') {
      try {
        const params=typeof body==='string' ? new URLSearchParams(body):body;
        const variables=JSON.parse(params.get('variables'));
        const allowed=new Set(['username','after','before','first','last','data','include_multi_captions']);
        const dataFields=new Set(['count','include_reel_media_seen_timestamp','include_relationship_info','latest_besties_reel_media','latest_reel_media']);
        const valid=Object.entries(variables).every(([name,value])=>allowed.has(name)
          || (name.startsWith('__relay_internal__pv__Polaris') && typeof value==='boolean'));
        if(valid && Object.entries(variables.data ?? {}).every(([name,value])=>dataFields.has(name) && ['number','boolean'].includes(typeof value))
            && variables.username===targetUsername && /^\d{1,30}$/.test(params.get('doc_id') ?? '')) {
          postsTemplate={path:url.pathname,docId:params.get('doc_id'),variables};
        }
      }catch { /* Unknown query shapes cannot be replayed. */ }
    }
    if(operation==='PolarisProfileReelsTabContentQuery_connection') {
      try {
        const params=typeof body==='string' ? new URLSearchParams(body):body;
        const variables=JSON.parse(params.get('variables'));
        if(Object.entries(variables).every(([name,value])=>['after','first','id','data'].includes(name)
            || (name.startsWith('__relay_internal__pv__Polaris') && typeof value==='boolean'))
            && Object.entries(variables.data ?? {}).every(([name,value])=>
              (name==='include_feed_video' && typeof value==='boolean') || (name==='page_size' && Number.isInteger(value))
              || (name==='target_user_id' && /^\d+$/.test(value))) && /^\d{1,30}$/.test(params.get('doc_id') ?? '')) {
          reelsTemplate={path:url.pathname,docId:params.get('doc_id'),variables};
        }
      }catch { /* Unknown query shapes cannot be replayed. */ }
    }
    return media;
  }
  function inspect(text) {
    if(!report.active || report.responses>=30)return;
    report.responses++;
    if(typeof text!=='string' || text.length>2000000) {report.errors++;return;}
    let visited=0;
    function visit(value) {
      if(!value || typeof value!=='object' || ++visited>20000)return;
      for(const [name,child] of Object.entries(value)) {
        if(/^xdt_[a-zA-Z0-9_]+$/.test(name) && !report.roots.includes(name) && report.roots.length<12)report.roots.push(name);
        if(/^[a-zA-Z_][a-zA-Z0-9_]{0,149}$/.test(name) && Array.isArray(child?.edges) && child.page_info && report.lists.length<12) {
          report.lists.push({name,count:child.edges.length,
            hasNext:typeof child.page_info.has_next_page==='boolean' ? child.page_info.has_next_page:null,
            hasCursor:typeof child.page_info.end_cursor==='string' && child.page_info.end_cursor.length>0,
            node:shape(child.edges[0]?.node)});
          const user=child.edges[0]?.node?.user;
          const username=location.pathname.split('/').filter(Boolean)[0];
          if(name==='xdt_api__v1__feed__user_timeline_graphql_connection' && child.edges.length<=50
              && user?.username?.toLowerCase()===username?.toLowerCase()) {
            sample={category:'posts',context:{username,accountId:String(user.pk ?? user.id),
              viewerId:document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)(?:;|$)/)?.[1]},
              response:{data:{[name]:{edges:child.edges.map(edge=>({node:project(edge.node)})),
                page_info:{has_next_page:child.page_info.has_next_page,end_cursor:child.page_info.end_cursor}}}}};
          }
          const reelUser=child.edges[0]?.node?.media?.user;
          if(name==='clips_connection' && child.edges.length<=50 && reelUser?.username?.toLowerCase()===targetUsername.toLowerCase()) {
            sample={category:'reels',context:{username:targetUsername,accountId:String(reelUser.pk ?? reelUser.id),
              viewerId:document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)(?:;|$)/)?.[1]}};
          }
        }
        if(name==='items' && Array.isArray(child) && child.some(item=>item?.image_versions2 || item?.video_versions || item?.media) && report.lists.length<12) {
          report.lists.push({name:'items',count:child.length,
            hasNext:typeof value.more_available==='boolean' ? value.more_available:null,
            hasCursor:typeof value.next_max_id==='string' && value.next_max_id.length>0,node:shape(child[0])});
          const detail=child.length===1 ? child[0]:null;
          const shortcode=location.pathname.match(/^\/reel\/([a-zA-Z0-9_-]+)\/?$/)?.[1];
          if(shortcode && detail?.code===shortcode && detail.user?.username?.toLowerCase()===targetUsername.toLowerCase()) {
            sample={category:'reels',detail:project(detail),context:{username:targetUsername,
              accountId:String(detail.user.pk ?? detail.user.id),
              viewerId:document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)(?:;|$)/)?.[1]}};
          }
        }
        visit(child);
      }
    }
    try {
      const cleaned=text.replace(/^for\s*\(;;\);\s*/,'');
      for(const line of cleaned.split('\n').filter(Boolean)) {
        const parsed=JSON.parse(line);
        if(report.envelopes.length<12)report.envelopes.push({
          dataKeys:Object.keys(parsed.data ?? {}).filter(name=>/^[a-zA-Z_][a-zA-Z0-9_]{0,149}$/.test(name)).slice(0,12),
          userStructure:parsed.data?.fetch__XDTUserDict ? schema(parsed.data.fetch__XDTUserDict):null,
          hasErrors:Array.isArray(parsed.errors) && parsed.errors.length>0});
        visit(parsed);
      }
    } catch {report.errors++;}
  }
  function wrappedFetch(...args) {
    const result=originalFetch.apply(this,args);
    if(mediaRequest(args[0],args[1]?.body,args[1]?.headers ?? args[0]?.headers))result.then(response=>{
      if(response.url && !eligible(response.url))return;
      if(report.active)response.clone().text().then(inspect).catch(()=>{report.errors++;});
    }).catch(()=>{report.errors++;});
    return result;
  }
  function wrappedOpen(method,url,...rest) {
    const previous=xhrListeners.get(this);
    if(previous){this.removeEventListener('load',previous);xhrListeners.delete(this);}
    xhrPaths.set(this,String(url));
    xhrHeaders.set(this,{});
    return originalOpen.call(this,method,url,...rest);
  }
  function wrappedSend(body) {
    const url=xhrPaths.get(this);
    if(url && mediaRequest(url,body,xhrHeaders.get(this))) {
      const listener=()=>{
        xhrListeners.delete(this);
        if(!report.active || (this.responseURL && !eligible(this.responseURL)))return;
        try {if(this.responseType==='' || this.responseType==='text')inspect(this.responseText);} catch {report.errors++;}
      };
      xhrListeners.set(this,listener);
      this.addEventListener('load',listener,{once:true});
    }
    return originalSend.call(this,body);
  }
  window.fetch=wrappedFetch;
  function wrappedSetHeader(name,value) {
    if(name.toLowerCase()==='x-ig-app-id' && /^\d{1,30}$/.test(value)) {
      const headers=xhrHeaders.get(this);if(headers)headers['X-IG-App-ID']=String(value);
    }
    return originalSetHeader.call(this,name,value);
  }
  if(originalSetHeader)XMLHttpRequest.prototype.setRequestHeader=wrappedSetHeader;
  XMLHttpRequest.prototype.open=wrappedOpen;
  XMLHttpRequest.prototype.send=wrappedSend;
  window[key]={report,sample:()=>sample,stop(){
    sample=null;
    postsTemplate=null;
    reelsTemplate=null;
    appId=null;
    report.active=false;
    if(window.fetch===wrappedFetch)window.fetch=originalFetch;
    if(XMLHttpRequest.prototype.open===wrappedOpen)XMLHttpRequest.prototype.open=originalOpen;
    if(XMLHttpRequest.prototype.send===wrappedSend)XMLHttpRequest.prototype.send=originalSend;
    if(XMLHttpRequest.prototype.setRequestHeader===wrappedSetHeader)XMLHttpRequest.prototype.setRequestHeader=originalSetHeader;
    delete window[key];
  },source() {
    if(!sample?.context)return {error:'尚未确认目标主页身份，请加载主页或 Reels 的后续分页。'};
    const queries={};
    for(const [category,template] of [['posts',postsTemplate],['reels',reelsTemplate]]) {
      if(!template)continue;
      const variables={...template.variables,after:null,data:{...template.variables.data}};
      delete variables.username;delete variables.id;delete variables.data.target_user_id;
      queries[category]={...template,variables};
    }
    return {context:{...sample.context},queries,appId};
  },async readPosts(cursor=null) {
    if(!postsTemplate || sample?.category!=='posts')return {code:'READER_NOT_READY',error:'缺少已验证的帖子分页请求，请加载一次后续分页。'};
    const context={...sample.context};
    const currentViewer=document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)(?:;|$)/)?.[1];
    if(location.pathname!==`/${targetUsername}/` || !currentViewer || currentViewer!==context.viewerId)return {code:'CONTEXT_CHANGED',error:'主页或登录账号已变化。'};
    if(!(cursor===null || (typeof cursor==='string' && cursor.length>0 && cursor.length<4096)))return {code:'INVALID_CURSOR',error:'分页游标无效。'};
    const variables={...postsTemplate.variables,after:cursor,before:null};
    const params=new URLSearchParams({doc_id:postsTemplate.docId,variables:JSON.stringify(variables),
      fb_api_req_friendly_name:'PolarisProfilePostsTabContentQuery_connection'});
    const csrf=document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    try {
      const response=await originalFetch.call(window,postsTemplate.path,{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/x-www-form-urlencoded',...(csrf ? {'X-CSRFToken':csrf}:{})},body:params.toString()});
      if(response.status===429)return {code:'RATE_LIMITED',error:'Instagram 限制访问，请稍后手动恢复。'};
      if([401,403].includes(response.status))return {code:'LOGIN_REQUIRED',error:'访问被拒绝，请检查登录状态。'};
      if(!response.ok || (response.url && new URL(response.url,location.href).origin!==location.origin))return {code:'READ_FAILED',error:'帖子读取失败。'};
      const text=await response.text();
      if(text.length>2000000)return {code:'READ_FAILED',error:'帖子响应大小异常。'};
      for(const line of text.replace(/^for\s*\(;;\);\s*/,'').split('\n').filter(Boolean)) {
        const connection=JSON.parse(line).data?.xdt_api__v1__feed__user_timeline_graphql_connection;
        if(!Array.isArray(connection?.edges) || connection.edges.length>50)continue;
        if(!report.active || location.pathname!==`/${targetUsername}/` || document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)(?:;|$)/)?.[1]!==currentViewer)return {code:'CONTEXT_CHANGED',error:'读取过程中主页或登录账号变化。'};
        return {category:'posts',context,response:{data:{xdt_api__v1__feed__user_timeline_graphql_connection:{
          edges:connection.edges.map(edge=>({node:project(edge.node)})),page_info:connection.page_info}}}};
      }
      return {code:'READ_FAILED',error:'缺少帖子列表，完整性未确认。'};
    }catch {return {code:'READ_FAILED',error:'帖子请求或响应格式异常。'};}
  }};
  return report;
}
