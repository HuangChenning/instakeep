function database() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('instakeep-destination',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('settings');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function access(mode,value) {
  const db=await database();
  try {
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction('settings',mode);
      const request=value ? tx.objectStore('settings').put(value,'destination'):tx.objectStore('settings').get('destination');
      tx.oncomplete=()=>resolve(request.result);
      tx.onabort=()=>reject(tx.error);
    });
  }finally{db.close();}
}
export const loadDestination=()=>access('readonly');
export async function saveDestination(handle) {
  const previous=await loadDestination();
  const id=previous && await handle.isSameEntry(previous.handle) ? previous.id:crypto.randomUUID();
  await access('readwrite',{id,name:handle.name,handle});
}
export async function requireDestination(destination=undefined) {
  destination ??= await loadDestination();
  if(!destination || await destination.handle.queryPermission({mode:'readwrite'})!=='granted') {
    throw Object.assign(new Error('保存目录需要授权，请选择或重新授权文件夹。'),{code:'DESTINATION_REQUIRED'});
  }
  return destination;
}
export async function writeFile(handle,path,body) {
  const parts=path.split('/');
  let directory=handle;
  for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part,{create:true});
  const original=parts.at(-1);
  let name=original;
  for(;;) {
    try {await directory.getFileHandle(name);}
    catch(error) {if(error.name==='NotFoundError')break;throw error;}
    const dot=original.lastIndexOf('.');
    name=dot>0 ? `${original.slice(0,dot)}_${crypto.randomUUID()}${original.slice(dot)}`:`${original}_${crypto.randomUUID()}`;
  }
  const file=await directory.getFileHandle(name,{create:true});
  const writable=await file.createWritable();
  try {
    if(body instanceof ReadableStream)await body.pipeTo(writable);
    else {await writable.write(body);await writable.close();}
  }catch(error){await writable.abort().catch(()=>{});throw error;}
  return [...parts.slice(0,-1),name].join('/');
}
