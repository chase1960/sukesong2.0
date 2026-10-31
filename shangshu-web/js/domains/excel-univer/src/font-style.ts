/** 字体是受管样式补丁，不能借格式入口更改值、公式或其他样式。 */
export const NUMBER_FORMATS=['General','0','0.00','#,##0','#,##0.00','0%','0.00%','yyyy-mm-dd','yyyy-mm-dd hh:mm:ss'] as const;
export interface BorderEdge {style:string|null;color:string|null;color_type?:string}
/** 边框预设：按**选区**算，不是按格子算（外框只画选区外围，内框只画内部）。 */
export const BORDER_PRESETS=['none','all','outer','inner','top','bottom','left','right'] as const;
export type BorderPreset=typeof BORDER_PRESETS[number];
export const BORDER_STYLES=['thin','hair','dotted','dashed','dashDot','dashDotDot','double','medium',
  'mediumDashed','mediumDashDot','mediumDashDotDot','slantDashDot','thick'] as const;
/** FIX-18 扩展格式：填充色 / 斜体 / 下划线 / 水平垂直对齐 / 清除格式。 */
export const HORIZONTAL_ALIGNS=['left','center','right','none'] as const;
export const VERTICAL_ALIGNS=['top','center','bottom','none'] as const;
export type HorizontalAlign=typeof HORIZONTAL_ALIGNS[number];
export type VerticalAlign=typeof VERTICAL_ALIGNS[number];
export const ALIGN_LABELS:{key:'horizontal_align'|'vertical_align';value:string;label:string}[]=[
  {key:'horizontal_align',value:'left',label:'靠左'},
  {key:'horizontal_align',value:'center',label:'居中'},
  {key:'horizontal_align',value:'right',label:'靠右'},
  {key:'horizontal_align',value:'none',label:'默认'},
  {key:'vertical_align',value:'top',label:'靠上'},
  {key:'vertical_align',value:'center',label:'垂直居中'},
  {key:'vertical_align',value:'bottom',label:'靠下'},
  {key:'vertical_align',value:'none',label:'默认'},
];
export interface CellFontStyle {
  number_format?:string; wrap_text?:boolean; border?:Record<'top'|'bottom'|'left'|'right',BorderEdge>;
  font_size?: number | null;
  font_color?: string | null;
  font_color_type?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fill_color?: string | null;
  horizontal_align?: string | null;
  vertical_align?: string | null;
}
export interface FontStylePatch {
  number_format?:string; wrap_text?:boolean; border?:BorderSpec;
  font_size?: number; font_color?: string; bold?: boolean;
  italic?: boolean; underline?: boolean;
  fill_color?: string; horizontal_align?: string; vertical_align?: string;
  clear_format?: boolean;
}
export interface BorderSpec {preset:BorderPreset;style?:string;color?:string}
export interface StyleTarget { row_id: string; header: string }
export interface StyleWriteResult {
  kind: 'style'; table: string; op_id: string; applied: number;
  content_version: number; structure_version: number;
  cells: Array<StyleTarget & { before: CellFontStyle; after: CellFontStyle }>;
}
const STYLE_KEYS=['font_size','font_color','font_color_type','bold','italic','underline','number_format','wrap_text','border','fill_color','horizontal_align','vertical_align'];
const PATCH_KEYS=['font_size','font_color','bold','italic','underline','number_format','wrap_text','border','fill_color','horizontal_align','vertical_align','clear_format'];
export function validateFontState(style:CellFontStyle):CellFontStyle{
  if(!style||typeof style!=='object'||Object.keys(style).some(key=>!STYLE_KEYS.includes(key))||style.font_size!=null&&(typeof style.font_size!=='number'||!Number.isFinite(style.font_size)||style.font_size<1||style.font_size>409)||style.font_color!=null&&(typeof style.font_color!=='string'||!/^#[0-9a-f]{6}$/i.test(style.font_color))||style.bold!==undefined&&typeof style.bold!=='boolean')throw Error('字体回执格式无效，请核实原操作');
  if(style.number_format!==undefined&&typeof style.number_format!=='string'||style.wrap_text!==undefined&&typeof style.wrap_text!=='boolean')throw Error('显示格式回执无效');
  if(style.italic!==undefined&&typeof style.italic!=='boolean')throw Error('斜体回执无效');
  if(style.underline!==undefined&&typeof style.underline!=='boolean')throw Error('下划线回执无效');
  if(style.fill_color!=null&&(typeof style.fill_color!=='string'||!/^#[0-9a-f]{6}$/i.test(style.fill_color)))throw Error('填充色回执无效');
  if(style.horizontal_align!=null&&!HORIZONTAL_ALIGNS.slice(0,3).includes(style.horizontal_align as HorizontalAlign))throw Error('水平对齐回执无效');
  if(style.vertical_align!=null&&!VERTICAL_ALIGNS.slice(0,3).includes(style.vertical_align as VerticalAlign))throw Error('垂直对齐回执无效');
  if(style.border!==undefined){if(!style.border||typeof style.border!=='object'||Object.keys(style.border).some(k=>!['top','bottom','left','right'].includes(k)))throw Error('边框回执无效');for(const edge of Object.values(style.border)){if(!edge||typeof edge!=='object'||Object.keys(edge).some(k=>!['style','color','color_type'].includes(k))||edge.style!==null&&typeof edge.style!=='string'||edge.color!==null&&(typeof edge.color!=='string'||!/^#[0-9a-f]{6}$/i.test(edge.color)))throw Error('边框回执无效');}}
  return style;
}
export function validateFontPatch(patch: FontStylePatch): FontStylePatch {
  const keys=Object.keys(patch);
  if(!keys.length||keys.some(key=>!PATCH_KEYS.includes(key)))throw Error('请选择已支持的字体设置');
  if(patch.font_size!==undefined&&(!Number.isFinite(patch.font_size)||patch.font_size<1||patch.font_size>409))throw Error('字号须为1至409磅');
  if(patch.font_color!==undefined&&!/^#[0-9a-f]{6}$/i.test(patch.font_color))throw Error('字体颜色须为完整RGB颜色');
  if(patch.bold!==undefined&&typeof patch.bold!=='boolean')throw Error('加粗设置无效');
  if(patch.italic!==undefined&&typeof patch.italic!=='boolean')throw Error('斜体设置无效');
  if(patch.underline!==undefined&&typeof patch.underline!=='boolean')throw Error('下划线设置无效');
  if(patch.fill_color!==undefined&&patch.fill_color!=='none'&&!/^#[0-9a-f]{6}$/i.test(patch.fill_color))throw Error('填充色须为完整RGB颜色');
  if(patch.horizontal_align!==undefined&&!HORIZONTAL_ALIGNS.includes(patch.horizontal_align as HorizontalAlign))throw Error('水平对齐设置无效');
  if(patch.vertical_align!==undefined&&!VERTICAL_ALIGNS.includes(patch.vertical_align as VerticalAlign))throw Error('垂直对齐设置无效');
  if(patch.clear_format!==undefined&&typeof patch.clear_format!=='boolean')throw Error('清除格式设置无效');
  if(patch.clear_format===true&&keys.some(key=>key!=='clear_format'))throw Error('清除格式不能与其他设置同时使用，请分两步做');
  if(patch.number_format!==undefined&&!NUMBER_FORMATS.includes(patch.number_format as any))throw Error('请选择已支持的数字或日期格式');
  if(patch.wrap_text!==undefined&&typeof patch.wrap_text!=='boolean')throw Error('换行设置无效');
  if(patch.border!==undefined){
    const border=patch.border;
    if(!border||typeof border!=='object'||!BORDER_PRESETS.includes(border.preset as BorderPreset))throw Error('边框预设无效');
    if(border.style!==undefined&&!BORDER_STYLES.includes(border.style as any))throw Error('边框线型无效');
    if(border.color!==undefined&&!/^#[0-9a-f]{6}$/i.test(border.color))throw Error('边框颜色须为完整RGB颜色');
  }
  return {...patch};
}
export function buildStyleTargets(options:{
  range:{startRow:number;endRow:number;startCol:number;endCol:number};
  columns:Array<{fieldId:string;readOnly:boolean}>;
  rowId(index:number):string|undefined;
}):StyleTarget[]{
  const {range,columns}=options;
  if(![range.startRow,range.endRow,range.startCol,range.endCol].every(n=>Number.isInteger(n)&&n>=0)||range.endRow<range.startRow||range.endCol<range.startCol)throw Error('请先选择要设置字体的单元格');
  if((range.endRow-range.startRow+1)*(range.endCol-range.startCol+1)>20000)throw Error('一次最多设置两万格，请缩小选区');
  for(let col=range.startCol;col<=range.endCol;col++)if(!columns[col]||columns[col].readOnly)throw Error('选区包含只读列或未建立的列，整包未修改');
  const targets:StyleTarget[]=[];
  for(let row=range.startRow;row<=range.endRow;row++){
    const id=options.rowId(row);if(!id)throw Error('选区包含未加载或尚未建立的行，请先加载这些行');
    for(let col=range.startCol;col<=range.endCol;col++)targets.push({row_id:id,header:columns[col].fieldId});
  }
  return targets;
}
export function fontStyleToUniver(style?:CellFontStyle):Record<string,unknown>{
  const result:Record<string,unknown>={};
  if(typeof style?.font_size==='number'&&Number.isFinite(style.font_size)&&style.font_size>0)result.fs=style.font_size;
  else if(style?.font_size===null)result.fs=null;
  if(typeof style?.font_color==='string'&&/^#[0-9a-f]{6}$/i.test(style.font_color))result.cl={rgb:style.font_color};
  else if(style?.font_color===null)result.cl=null;
  if(typeof style?.bold==='boolean')result.bl=style.bold?1:0;
  if(typeof style?.italic==='boolean')result.it=style.italic?1:0;
  if(typeof style?.underline==='boolean')result.ul=style.underline?{s:1,c:1}:null;
  if(typeof style?.fill_color==='string'&&/^#[0-9a-f]{6}$/i.test(style.fill_color))result.bg={rgb:style.fill_color};
  else if(style?.fill_color===null)result.bg=null;
  if(typeof style?.horizontal_align==='string'&&['left','center','right'].includes(style.horizontal_align))result.ht=style.horizontal_align;
  else if(style?.horizontal_align===null)result.ht=null;
  // Univer 的垂直对齐中间档叫 middle（xlsx 里叫 center），这里做一次翻译。
  if(typeof style?.vertical_align==='string'&&['top','center','bottom'].includes(style.vertical_align))result.vt=style.vertical_align==='center'?'middle':style.vertical_align;
  else if(style?.vertical_align===null)result.vt=null;
  if(typeof style?.number_format!=='undefined')result.n={pattern:style.number_format};
  if(typeof style?.wrap_text!=='undefined')result.tb=style.wrap_text?3:2;
  if(style?.border){const codes:Record<string,number>={thin:1,hair:2,dotted:3,dashed:4,dashDot:5,dashDotDot:6,double:7,medium:8,mediumDashed:9,mediumDashDot:10,mediumDashDotDot:11,slantDashDot:12,thick:13};const bd:Record<string,unknown>={};for(const [side,key] of [['top','t'],['bottom','b'],['left','l'],['right','r']] as const){const edge=style.border[side];bd[key]=edge?.style?{s:codes[edge.style]??1,cl:{rgb:edge.color??'#D1D5DB'}}:null;}result.bd=bd;}
  return result;
}
/** 完整回执才推进版本/显示；HTTP 200 并不保证拿到了有效样式结果。 */
export function validateStyleReceipt(result:StyleWriteResult,table:string,opId:string,targets:StyleTarget[]):StyleWriteResult{
  if(result?.kind!=='style'||result.table!==table||result.op_id!==opId||!Number.isInteger(result.content_version)||!Number.isInteger(result.structure_version)||!Array.isArray(result.cells)||!Number.isInteger(result.applied)||result.applied<0||result.cells.length!==result.applied||result.cells.length>targets.length)throw Error('字体保存回执不完整，请按原操作编号核实重试');
  const expected=new Set(targets.map(cell=>JSON.stringify([cell.row_id,cell.header])));
  for(const cell of result.cells){const key=JSON.stringify([cell.row_id,cell.header]);if(!expected.delete(key))throw Error('字体保存回执目标不一致，请按原操作编号核实重试');validateFontState(cell.after);}
  return result;
}
