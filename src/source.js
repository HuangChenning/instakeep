// Serialized into Instagram's page; authentication is used only for this same-origin request.
export async function readSource(input) {
  const {category,query,cursor=null,contentId=null,appId=null,single=false,singlePath=null}=input;
  let context=input.context;
  const fail=(code,error)=>({code,error});
  const viewer=()=>document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)(?:;|$)/)?.[1];
  const publicAppId=/^\d{6,30}$/.test(appId ?? '') ? appId
    : [...(document.scripts ?? [])].map(script=>script.textContent?.match(/"appId":(\d{6,30})/)?.[1]).find(Boolean);
  const initialPath=location.pathname;
  const postPath=singlePath ?? initialPath;
  const postCode=typeof postPath==='string'
    ? postPath.match(/^\/(?:[a-zA-Z0-9._]{1,30}\/)?(?:p|reel)\/([a-zA-Z0-9_-]{1,30})\/?$/)?.[1]:null;
  const singleViewer=viewer();
  const validContext=()=>location.protocol==='https:' && ['www.instagram.com','instagram.com'].includes(location.hostname)
    && (single ? Boolean(postCode && singleViewer && location.pathname===initialPath && viewer()===singleViewer)
      :Boolean(context && (context.postCode ? location.pathname===(context.sourcePath ?? context.postPath)
        :[`/${context.username}/`,`/${context.username}/reels/`].includes(location.pathname)) && viewer()===context.viewerId));
  if(!['posts','reels'].includes(category) || (!single && (!/^\d+$/.test(context?.accountId) || !/^\d+$/.test(context?.viewerId)
      || !/^[a-zA-Z0-9._]{1,30}$/.test(context?.username))) || !validContext())return fail('CONTEXT_CHANGED','主页、帖子或登录账号已变化。');
  const fields=new Set(['id','pk','code','media_type','product_type','user','username','taken_at','caption','text',
    'carousel_media','carousel_media_count','image_versions2','candidates','video_versions','url','width','height','original_width','original_height']);
  function project(value,depth=0) {
    if(depth>6)return null;
    if(Array.isArray(value))return value.slice(0,100).map(child=>project(child,depth+1));
    if(!value || typeof value!=='object')return value;
    return Object.fromEntries(Object.entries(value).filter(([name])=>fields.has(name)).map(([name,child])=>[name,project(child,depth+1)]));
  }
  async function request(path,options={}) {
    if(!validContext())throw fail('CONTEXT_CHANGED','主页或登录账号已变化。');
    const csrf=document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
    const response=await fetch(path,{...options,credentials:'same-origin',headers:{...options.headers,
      ...(publicAppId ? {'X-IG-App-ID':publicAppId}:{}),...(csrf ? {'X-CSRFToken':csrf}:{})}});
    if(response.status===429)throw fail('RATE_LIMITED','Instagram 限制访问，请稍后手动恢复。');
    if([401,403].includes(response.status))throw fail('LOGIN_REQUIRED','访问被拒绝，请检查登录状态。');
    if(!response.ok || (response.url && new URL(response.url,location.href).origin!==location.origin))throw fail('READ_FAILED',`Instagram ${path.includes('/media/') ? '媒体详情':'列表'}读取失败（HTTP ${response.status}）。`);
    const text=await response.text();
    if(text.length>2000000 || !validContext())throw fail('CONTEXT_CHANGED','响应大小异常或账号上下文已变化。');
    return text.replace(/^for\s*\(;;\);\s*/,'').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  }
  async function detail(id) {
    if(!/^\d+$/.test(id))throw fail('READ_FAILED','媒体身份无效。');
    const parts=await request(`/api/v1/media/${id}/info/`);
    const item=parts[0]?.items?.[0];
    if(parts[0]?.items?.length!==1 || String(item?.pk ?? item?.id).split('_')[0]!==id)throw fail('READ_FAILED','媒体详情身份不匹配。');
    return project(item);
  }
  try {
    if(single) {
      const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const id=[...postCode].reduce((value,char)=>value*64n+BigInt(alphabet.indexOf(char)),0n).toString();
      const media=await detail(id);
      const accountId=String(media.user?.pk ?? media.user?.id ?? '');
      const username=media.user?.username;
      if(media.code!==postCode || !/^\d+$/.test(accountId) || !/^[a-zA-Z0-9._]{1,30}$/.test(username ?? ''))return fail('READ_FAILED','帖子身份未确认。');
      context={accountId,username,viewerId:singleViewer,postCode,postPath,sourcePath:initialPath};
      return {detail:media,context,category};
    }
    if(contentId)return {detail:await detail(contentId),context,category};
    if(!query || !['/graphql/query','/graphql/query/','/api/graphql'].includes(query.path) || !/^\d{1,30}$/.test(query.docId)
        || !(cursor===null || (typeof cursor==='string' && cursor.length>0 && cursor.length<4096)))return fail('READER_NOT_READY','请先准备当前类型的分页读取。');
    const allowed=category==='posts' ? ['after','before','first','last','data','include_multi_captions']:['after','first','data'];
    if(Object.entries(query.variables ?? {}).some(([name,value])=>!allowed.includes(name)
        && !(name.startsWith('__relay_internal__pv__Polaris') && typeof value==='boolean')))return fail('READ_FAILED','查询参数格式已变化。');
    const variables={...query.variables,after:cursor,data:{...query.variables.data}};
    if(category==='posts')variables.username=context.username;
    else {variables.id=context.accountId;variables.data.target_user_id=context.accountId;}
    const body=new URLSearchParams({doc_id:query.docId,variables:JSON.stringify(variables),
      fb_api_req_friendly_name:category==='posts' ? 'PolarisProfilePostsTabContentQuery_connection':'PolarisProfileReelsTabContentQuery_connection'});
    const parts=await request(query.path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
    const key='xdt_api__v1__feed__user_timeline_graphql_connection';
    const connection=parts.map(part=>category==='posts' ? part.data?.[key]:part.data?.fetch__XDTUserDict?.clips_connection).find(Boolean);
    if(!Array.isArray(connection?.edges) || connection.edges.length>50)return fail('READ_FAILED','未取得分类列表，完整性未确认。');
    const edges=[];
    for(const edge of connection.edges) {
      let media=category==='posts' ? edge.node:edge.node?.media;
      if(category==='reels') {
        if(media?.user?.username?.toLowerCase()!==context.username.toLowerCase() || String(media.user.pk ?? media.user.id)!==context.accountId)throw fail('CONTEXT_CHANGED','Reels 账号与目标不匹配。');
        await new Promise(resolve=>setTimeout(resolve,1000));
        media=await detail(String(media.pk ?? media.id).split('_')[0]);
      }
      edges.push({node:project(media)});
    }
    const normalized={edges,page_info:connection.page_info};
    return {context,category,response:{data:category==='posts' ? {[key]:normalized}:{fetch__XDTUserDict:{clips_connection:normalized}}}};
  }catch(error) {return error?.code ? error:fail('READ_FAILED','请求或响应格式异常，请稍后重试。');}
}
