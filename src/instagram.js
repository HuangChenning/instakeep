import {CATEGORIES} from './model.js';
import {downloadOptions} from './downloads.js';
function identity(value) {
  if(typeof value==='number' && !Number.isSafeInteger(value))throw new Error('媒体身份精度不可靠。');
  const text=String(value ?? '');
  if(!/^\d+(?:_\d+)?$/.test(text))throw new Error('缺少稳定媒体或账号身份。');
  return text.split('_')[0];
}
function normalizeMedia(raw,index) {
  const kind=raw.media_type===1 ? 'image':raw.media_type===2 ? 'video':null;
  if(!kind)throw new Error('媒体类型尚未确认，不能只保存预览图。');
  const candidates=kind==='image' ? raw.image_versions2?.candidates:raw.video_versions;
  if(!Array.isArray(candidates) || !candidates.length)throw new Error(`缺少${kind==='video' ? '视频':'图片'}候选地址。`);
  let chosen;
  for(const candidate of candidates) {
    if(!Number.isInteger(candidate.width) || !Number.isInteger(candidate.height) || candidate.width<=0 || candidate.height<=0)throw new Error('媒体尺寸格式已变化。');
    downloadOptions({type:'media',relativePath:'validation.jpg'},candidate.url);
    if(!chosen || candidate.width*candidate.height>chosen.width*chosen.height)chosen=candidate;
  }
  const extension=new URL(chosen.url).pathname.match(/\.([a-zA-Z0-9]+)$/)?.[1].toLowerCase();
  if(!(kind==='video' ? extension==='mp4':['jpg','jpeg','png','webp','avif'].includes(extension)))throw new Error('媒体文件格式未确认。');
  return {id:identity(raw.pk ?? raw.id),index,kind,url:chosen.url,extension,width:chosen.width,height:chosen.height,
    qualityNote:raw.original_width>chosen.width || raw.original_height>chosen.height ? '网页提供的候选版本小于记录的原始尺寸。':null};
}
export function normalizeContent(raw,context,category,highlight=null) {
  if(!CATEGORIES.includes(category))throw new Error('不支持的内容类型。');
  if(identity(raw.user?.pk ?? raw.user?.id)!==context.accountId || raw.user?.username?.toLowerCase()!==context.username.toLowerCase())throw new Error('内容账号与目标主页不匹配。');
  const id=identity(raw.pk ?? raw.id);
  if(typeof raw.code!=='string' || !/^[a-zA-Z0-9_-]+$/.test(raw.code))throw new Error('原帖链接身份未确认。');
  let publishedAt=null;
  if(raw.taken_at!=null) {
    if(!Number.isInteger(raw.taken_at) || raw.taken_at<=0 || raw.taken_at>8640000000000)throw new Error('发布时间格式无效。');
    publishedAt=new Date(raw.taken_at*1000).toISOString();
  }
  const carousel=raw.media_type===8;
  const members=carousel ? raw.carousel_media:[raw];
  if(!Array.isArray(members) || !members.length || (carousel && raw.carousel_media_count!==members.length))throw new Error('轮播媒体清单不完整。');
  for(const member of members)if(member.user && identity(member.user.pk ?? member.user.id)!==context.accountId)throw new Error('轮播媒体账号不匹配。');
  return {id,accountId:context.accountId,username:context.username,category,
    permalink:`https://www.instagram.com/${category==='reels' ? 'reel':'p'}/${raw.code}/`,publishedAt,
    caption:typeof raw.caption?.text==='string' ? raw.caption.text:'',highlight,media:members.map((member,index)=>normalizeMedia(member,index+1))};
}
export function normalizePage(response,context,category,cursor=null) {
  if(!['posts','reels'].includes(category))throw new Error('此类型的分页读取尚未验证。');
  const connection=category==='posts' ? response?.data?.xdt_api__v1__feed__user_timeline_graphql_connection
    :response?.data?.fetch__XDTUserDict?.clips_connection;
  if(!Array.isArray(connection?.edges))throw new Error('缺少已验证的主页帖子列表。');
  const info=connection.page_info;
  if(typeof info?.has_next_page!=='boolean' || !(info.end_cursor===null || typeof info.end_cursor==='string')
      || (info.has_next_page && !info.end_cursor) || (!info.has_next_page && info.end_cursor!==null))throw new Error('分页结束标记或游标未确认。');
  if(info.end_cursor!==null && info.end_cursor===cursor)throw new Error('分页游标重复，完整性未确认。');
  if(!connection.edges.length && info.has_next_page)throw new Error('非末页返回空页，完整性未确认。');
  return {contents:connection.edges.map(edge=>normalizeContent(edge.node,context,category)),nextCursor:info.end_cursor,
    terminal:!info.has_next_page,context:{accountId:context.accountId,viewerId:context.viewerId},warnings:[]};
}
