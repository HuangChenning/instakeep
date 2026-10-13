export const CATEGORIES = ['posts', 'reels', 'stories', 'highlights'];
export function mediaKey(media) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(media.id ?? '')) || !Number.isInteger(media.index) || media.index < 1) {
    throw new Error('缺少稳定媒体身份或轮播序号。');
  }
  return `${media.id}:${media.index}`;
}
export function completion(task, items) {
  return task.selectedCategories.length > 0
    && task.selectedCategories.every(category => task.scans[category]?.state === 'complete')
    && items.every(item => ['succeeded','skipped'].includes(item.state)) ? 'complete' : 'incomplete';
}
