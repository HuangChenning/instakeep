import { CATEGORIES } from './model.js';
export const DEFAULT_SETTINGS = Object.freeze({root:'',folderTemplate:'',filenameTemplate:'{date}_{id}_{index}',metadata:true});
const fields = new Set(['username','date','type','id','index']);
const extensions = new Set(['jpg','jpeg','png','webp','avif','mp4']);
function segment(value) {
  let text = String(value).normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').trim();
  if (!text || text === '.' || text === '..') text = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)) text = `_${text}`;
  return text.slice(0,120);
}
export function validateSettings(settings) {
  const values = {...DEFAULT_SETTINGS,...settings};
  const errors = [];
  for (const key of ['root','folderTemplate','filenameTemplate']) {
    const text = values[key];
    if(key!=='filenameTemplate' && text==='')continue;
    if (typeof text !== 'string' || !text.trim() || text.startsWith('/') || /[\\:\u0000-\u001f]/.test(text)
        || text.split('/').some(part => !part || part === '..' || part === '.')
        || (key === 'filenameTemplate' && text.includes('/'))) {
      errors.push(`${key} 必须是有效的相对路径或文件名。`);
      continue;
    }
    for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
      if (!fields.has(match[1]) || key === 'root') errors.push(`不支持字段 {${match[1]}。`);
    }
    if (/[{}]/.test(text.replace(/\{[^{}]*\}/g,''))) errors.push('模板括号不完整。');
  }
  if (typeof values.metadata !== 'boolean') errors.push('来源信息设置必须为开关。');
  return {valid:errors.length === 0,errors};
}
export function highlightFolders(highlights) {
  const groups = new Map();
  for (const highlight of highlights) {
    const name = segment(highlight.title || '精选');
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push({id:String(highlight.id),name});
  }
  return Object.fromEntries([...groups.values()].flatMap(group => group.map(({id,name}) =>
    [id,group.length > 1 ? `${name}_${segment(id)}` : name])));
}
export function buildPath(content, media, settings = {}) {
  const check = validateSettings(settings);
  if (!check.valid) throw new Error(check.errors.join(' '));
  if (!CATEGORIES.includes(content.category) || !extensions.has(media.extension)) throw new Error('不支持的媒体格式或类型。');
  const options = {...DEFAULT_SETTINGS,...settings};
  const date = content.publishedAt ? new Date(content.publishedAt) : null;
  if (date && Number.isNaN(date.getTime())) throw new Error('发布时间格式无效。');
  const values = {username:segment(content.username),date:date?.toISOString().slice(0,10) ?? '',type:content.category,
    id:segment(content.id),index:content.media.length > 1 ? String(media.index) : ''};
  const render = template => template.replace(/\{([^{}]+)\}/g,(_,key)=>values[key]);
  let folder = options.folderTemplate ? render(options.folderTemplate).split('/').map(segment).join('/') : '';
  if (content.category === 'highlights') {
    if (!content.highlight?.id) throw new Error('缺少精选身份。');
    folder = [folder,segment(options.highlightFolders?.[content.highlight.id] ?? content.highlight.title ?? '精选')].filter(Boolean).join('/');
  }
  let name = segment(render(options.filenameTemplate).replace(/_+/g,'_').replace(/^_|_$/g,''));
  if (!options.filenameTemplate.includes('{id}')) name += `_${values.id}${values.index ? `_${values.index}` : ''}`;
  else if (values.index && !options.filenameTemplate.includes('{index}')) name += `_${values.index}`;
  const root = options.root ? options.root.split('/').map(segment).join('/') : '';
  return [root,folder,`${name}.${media.extension}`].filter(Boolean).join('/');
}
