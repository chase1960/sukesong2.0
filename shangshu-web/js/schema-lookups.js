/* 列表录入与流程表单共用关联选择，所有查询仍走当前用户公共对象接口。 */
function schemaWithLookups(input, references={}, fieldOrder=[]) {
  const schema=JSON.parse(JSON.stringify(input));
  if(fieldOrder.length&&schema.properties){const original=schema.properties;schema.properties={};for(const id of [...fieldOrder,...Object.keys(original)])if(original[id])schema.properties[id]=original[id];}
  for(const [path,target] of Object.entries(references)){
    const parts=path.split('.');let spec=schema.properties?.[parts[0]];
    if(parts.length===2)spec=spec?.items?.properties?.[parts[1]];
    if(!spec)continue;
    let label;
    spec.lookup=async({page,search,selected})=>{
      const query=new URLSearchParams({page:String(page),page_length:'30'});
      if(search&&label)query.set('filters',JSON.stringify({[label]:search}));
      const base='/api/platform/objects/'+encodeURIComponent(target)+'/records';
      const response=await api(base+'?'+query);const data=await response.json();
      if(!response.ok||data.ok===false)throw Error(data.error||'关联记录读取失败');
      label=data.object?.fields?.find(f=>f.type==='text')?.id;
      const options=(data.rows||[]).map(row=>({value:row.name,label:String(row[label]||row.name)}));
      if(selected&&!options.some(item=>item.value===selected)){
        const current=await api(base+'/'+encodeURIComponent(selected));const detail=await current.json();
        if(!current.ok)throw Error('原关联记录不可访问，请重新选择');
        options.unshift({value:selected,label:String(detail.record?.[label]||selected)});
      }
      return {options,total:Number(data.total||0)};
    };
  }
  return schema;
}
