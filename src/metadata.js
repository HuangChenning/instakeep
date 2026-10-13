export function buildMetadata(content, mediaPaths) {
  return {id:content.id,accountId:content.accountId,username:content.username,category:content.category,
    permalink:content.permalink,publishedAt:content.publishedAt,caption:content.caption,
    highlight:content.highlight ?? null,
    media:content.media.map((media,index)=>({id:media.id,index:media.index,kind:media.kind,path:mediaPaths[index],qualityNote:media.qualityNote ?? null}))};
}
