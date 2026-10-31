// 无写入的候选编排：只消费已授权原件/对象，正式保存仍由原公共 Action 执行。
import Ajv from 'ajv';
type Data=Record<string,any>;
export type FileSource={ref_doctype:string;ref_name:string;file:string};
type Dependencies={
  getRecord:()=>Promise<Data>;
  readFile:(source:FileSource,verifyOnly?:boolean)=>Promise<{name:string;bytes:Buffer}>;
  previewDocx:(source:FileSource)=>Promise<Data>;
  recognize:(name:string,bytes:Buffer)=>Promise<string>;
  generate:(input:{text:string;fields:Data[]})=>Promise<unknown>;
};
const ajv=new Ajv({strict:false,validateFormats:false});
export async function readRecordFileText(source:FileSource,deps:Pick<Dependencies,'readFile'|'previewDocx'|'recognize'>){
  if(!source||Object.keys(source).length!==3||!['ref_doctype','ref_name','file'].every(k=>typeof source[k as keyof FileSource]==='string'&&source[k as keyof FileSource].trim()&&source[k as keyof FileSource].length<=140))throw Error('附件引用无效');
  const original=await deps.readFile(source),ext=original.name.toLowerCase().split('.').pop();
  if(original.bytes.length>20*1024*1024)throw Error('原件超过20MB候选提取上限');
  let text='';
  if(['txt','md','csv'].includes(ext||''))text=new TextDecoder('utf-8',{fatal:true}).decode(original.bytes);
  else if(ext==='docx'){
    const doc=await deps.previewDocx(source);
    text=(doc.blocks||[]).map((b:Data)=>b.type==='table'?(b.rows||[]).map((r:string[])=>r.join('\t')).join('\n'):b.text||'').join('\n');
  }else if(['pdf','png','jpg','jpeg'].includes(ext||''))text=await deps.recognize(original.name,original.bytes);
  else throw Error('此格式暂不支持候选提取，请预览原件后人工填写');
  if(!text.trim())throw Error('没有可核对的正文，请人工填写');
  if(text.length>20000)throw Error('正文超过20000字，请拆分文件或人工核对；未截断提取');
  return {name:original.name,text};
}
export async function suggestRecordFields(source:FileSource,deps:Dependencies){
  const before=await deps.getRecord(),obj=before.object,properties=obj?.input_schema?.properties||{};
  if(obj?.source!=='managed'||!obj.operations?.includes('update'))throw Error('当前记录不支持字段编辑');
  const fields=(obj.fields||[]).filter((f:Data)=>Object.hasOwn(properties,f.id)&&['text','long_text','choice','date','integer','number','decimal','boolean'].includes(f.type));
  if(!fields.length||fields.length>100)throw Error('请使用包含1至100个可编辑标量字段的数据表');
  const {text}=await readRecordFileText(source,deps);
  const candidates=await deps.generate({text,fields:fields.map((f:Data)=>({id:f.id,label:f.label,type:f.type,...(f.options?{options:f.options}:{})}))});
  if(!Array.isArray(candidates)||candidates.length>fields.length)throw Error('AI候选格式无效，请人工核对');
  const seen=new Set();
  for(const c of candidates){
    const field=fields.find((f:Data)=>f.id===c?.field);
    if(!field||seen.has(c.field)||typeof c.evidence!=='string'||!c.evidence.trim()||c.evidence.length>300||!text.includes(c.evidence)||!ajv.validate(properties[c.field],c.value))throw Error('AI候选字段、值或原文依据无效，请人工核对');
    if(field.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(c.value)||!Number.isFinite(Date.parse(c.value))||new Date(c.value).toISOString().slice(0,10)!==c.value))throw Error('AI候选日期无效');
    seen.add(c.field);
  }
  // 生成可能耗时；撤权或版本变化后不得把旧候选交付为当前可用输入。
  const after=await deps.getRecord();await deps.readFile(source,true);
  if(after.object?.revision!==obj.revision||after.record?.modified!==before.record?.modified||!after.object?.operations?.includes('update'))throw Error('记录或权限已变化，请重新打开审核');
  return {source,expected_revision:obj.revision,expected_modified:before.record.modified,candidates:candidates.map(c=>({field:c.field,value:c.value,evidence:c.evidence}))};
}
