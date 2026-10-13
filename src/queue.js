import { mediaKey } from './model.js';
import { buildPath } from './paths.js';
export function makeItems(task, contents) {
  return contents.flatMap(content => {
    if (content.accountId !== task.context.accountId) throw new Error('内容账号与任务不匹配。');
    const paths = content.media.map(media=>buildPath(content,media,task.settingsSnapshot));
    const items = content.media.map((media,index)=>({
      id:`${task.id}|media|${mediaKey(media)}`,taskId:task.id,contentId:content.id,accountId:content.accountId,
      mediaKey:`media|${mediaKey(media)}`,type:'media',media:{id:media.id,index:media.index},
      relativePath:paths[index],state:'pending',downloadId:null,attempts:0,nextRetryAt:0
    }));
    return items;
  });
}
