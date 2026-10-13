// Self-contained: Chrome serializes this function into the current page.
export function readContext(inspect = false) {
  const reserved = ['accounts','explore','p','reel','reels','stories','direct','about','developer','legal'];
  const parts = location.pathname.split('/').filter(Boolean);
  if (location.protocol !== 'https:' || !['instagram.com','www.instagram.com'].includes(location.hostname)
      || (parts.length !== 1 && !(inspect && parts.length===2 && parts[1]==='reels')) || !/^[a-zA-Z0-9._]{1,30}$/.test(parts[0])
      || reserved.includes(parts[0].toLowerCase())) {
    throw new Error('请打开 Instagram 用户主页。');
  }
  const username = parts[0];
  const viewerId = document.cookie.match(/(?:^|;\s*)ds_user_id=(\d+)(?:;|$)/)?.[1];
  if (!viewerId && !inspect) throw new Error('未确认登录状态，请先在 Instagram 网页登录。');
  let visited = 0;
  const ids = new Set();
  const evidence = {mediaObjects:0,shapes:[],pagination:[],connections:[],truncated:false,scripts:0,parsed:0,embeddedJSON:0,inlineMarkers:[]};
  const fields = new Set(['pk','id','code','media_type','product_type','taken_at','user','owner',
    'image_versions2','candidates','video_versions','carousel_media','carousel_media_count',
    'edge_sidecar_to_children','edge_media_to_caption','display_url','video_url','is_video',
    'width','height','original_width','original_height','url','edges','node','page_info','caption','text']);
  function shape(value, depth = 0) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return {length:value.length,item:depth < 5 && value.length ? shape(value[0],depth+1):'array'};
    if (typeof value !== 'object' || depth >= 5) return typeof value;
    return Object.fromEntries(Object.entries(value).filter(([key])=>fields.has(key))
      .map(([key,child])=>[key,shape(child,depth+1)]));
  }
  function visit(value) {
    if (typeof value === 'string' && /^[\[{]/.test(value) && value.length<=2000000 && visited<10000) {
      try {const nested=JSON.parse(value);evidence.embeddedJSON++;visit(nested);} catch { /* Text is not necessarily encoded JSON. */ }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (++visited > 10000) {evidence.truncated=true;return;}
    if (inspect) {
      for (const [key,child] of Object.entries(value)) {
        if (/^(?:xdt_[a-zA-Z0-9_]*connection|edge_owner_to_timeline_media)$/.test(key)
            && Array.isArray(child?.edges) && child.page_info && evidence.connections.length < 8) {
          evidence.connections.push({name:key,edges:child.edges.length,node:shape(child.edges[0]?.node)});
        }
      }
      if (value.image_versions2 || value.video_versions || value.carousel_media || value.display_url) {
        evidence.mediaObjects++;
        const sample = shape(value);
        if (evidence.shapes.length < 8 && !evidence.shapes.some(item=>JSON.stringify(item)===JSON.stringify(sample))) evidence.shapes.push(sample);
      }
      if (typeof value.has_next_page === 'boolean' && evidence.pagination.length < 8) {
        evidence.pagination.push({has_next_page:value.has_next_page,hasCursor:typeof value.end_cursor==='string' && value.end_cursor.length>0});
      }
      if (typeof value.more_available === 'boolean' && evidence.pagination.length < 8) {
        evidence.pagination.push({more_available:value.more_available,hasCursor:typeof value.next_max_id==='string' && value.next_max_id.length>0});
      }
    }
    if (typeof value.username === 'string' && value.username.toLowerCase() === username.toLowerCase()) {
      const id = String(value.pk ?? value.id ?? '');
      if (/^\d+$/.test(id)) ids.add(id);
    }
    for (const child of Object.values(value)) visit(child);
  }
  for (const script of [...document.querySelectorAll('script[type="application/json"]')].slice(0,100)) {
    evidence.scripts++;
    if (script.textContent.length > 2000000) {evidence.truncated=true;continue;}
    try { const parsed=JSON.parse(script.textContent);evidence.parsed++;visit(parsed); } catch { /* Non-profile JSON is not evidence. */ }
  }
  if(inspect)for(const script of [...document.querySelectorAll('script')].slice(0,200)) {
    const text=script.textContent;
    const markers=['ScheduledServerJS','RelayPrefetchedStreamCache','image_versions2','xdt_api__v1__','username'].filter(marker=>text.includes(marker));
    if(markers.length && evidence.inlineMarkers.length<12)evidence.inlineMarkers.push({type:script.type || 'classic',markers});
  }
  if (ids.size !== 1 && !inspect) throw new Error('未能确认主页身份；请等待页面加载，若仍失败需验证当前页面结构。');
  if (inspect) {evidence.identityMatches=ids.size;evidence.loginMarker=Boolean(viewerId);}
  return {username, accountId:ids.size===1 ? [...ids][0] : null, viewerId,...(inspect ? {evidence}:{})};
}
