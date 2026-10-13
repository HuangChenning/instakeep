import {loadDestination,saveDestination} from '../src/destination.js';
const status=document.getElementById('status');
const grant=document.getElementById('grant');
let destination;
async function refresh() {
  destination=await loadDestination();
  status.textContent=destination ? `当前文件夹：${destination.name}`:'尚未选择文件夹。';
  grant.hidden=!destination;
}
document.getElementById('choose').addEventListener('click',async()=>{
  try {
    const handle=await showDirectoryPicker({id:'instakeep-backup',mode:'readwrite',startIn:'downloads'});
    await saveDestination(handle);await refresh();
    status.textContent+='；已保存，可回到 Instagram 开始下载。';
  }catch(error){status.textContent=error.name==='AbortError' ? '已取消选择。':error.message;}
});
grant.addEventListener('click',async()=>{
  try {const permission=await destination.handle.requestPermission({mode:'readwrite'});status.textContent=permission==='granted' ? '写入权限已恢复。':'未获得写入权限。';}
  catch(error){status.textContent=error.message;}
});
void refresh();
