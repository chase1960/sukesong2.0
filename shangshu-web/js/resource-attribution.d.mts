export type Attribution = {level:'personal'|'department';department?:string};
export type AttributionLevel = {value:'personal'|'department';label?:string;hint?:string};
export type AttributionDepartment = {value:string;label?:string};
/** 调用方的工作面。摊开式之后组件**不再自己弹窗**，这个字段留着只为调用方不必改代码。 */
export type AttributionWorkspace = {
  dialog?: (options:{title?:string;body?:string|Element;actions?:{label?:string;variant?:string;onClick?:(element:Element)=>void}[];onEscape?:(event:Event)=>boolean;onClose?:()=>void}) => Element|null;
  closeModal?: (force?:boolean) => boolean;
  escape?: (value:unknown) => string;
  notify?: (message:string,kind?:string) => void;
};
export type AttributionOptions = {
  /** 摊开式不再自己弹窗；留着只是为了让调用方不必改代码。 */
  ui?: AttributionWorkspace|null;
  fetcher?: typeof fetch;
  defaultLevel?: ''|'personal'|'department';
  signal?: AbortSignal;
  /** 宿主里那一行的字段名（空串＝宿主自己已经有字段名了）。 */
  label?: string;
  levels?: AttributionLevel[];
  departmentLabel?: string;
  /** 'select' 从列表挑；'text' 手填（邮箱设置那种自由文本）。 */
  departmentMode?: 'select'|'text';
  /** 'platform' 组件自己读部门数据集；'provided' 调用方给列表。 */
  departmentSource?: 'platform'|'provided';
  departments?: AttributionDepartment[];
  departmentPlaceholder?: string;
  /** 给承载值的隐藏 input 起名字（沿用宿主原来的 id）。 */
  levelInputId?: string;
  departmentInputId?: string;
  onChange?: (value:{level:string;department:string}) => void;
};
export function mountResourceAttribution(host:HTMLElement,options?:AttributionOptions):{
  read():{ok:true;value:Attribution}|{ok:false;reason:string;focus:HTMLElement|null};
  load():Promise<unknown>;
  reset(level?:''|'personal'|'department'):void;
  lock(value:boolean):void;
  setValue(value:{level?:string;department?:string}):void;
  getValue():{level:string;department:string};
  setDepartments(rows:AttributionDepartment[]):void;
  sync():void;
  /** 承载值的隐藏 input（不是 select 了 —— 宿主里不再有原生下拉）。 */
  level:HTMLInputElement;department:HTMLInputElement;
  /** 当前选中部门的显示名。 */
  departmentText():string;
};
