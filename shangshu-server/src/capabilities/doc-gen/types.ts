// doc-gen 数据模型（模板集 / 文档类型 / 生成记录）

export interface TemplateSet {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'pending_review' | 'active' | 'archived';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentType {
  id: string;
  template_set_id: string;
  doc_key: string;
  name: string;
  description: string;
  template_file_token: string;
  field_schema: FieldSchema;
  validation_rules?: Record<string, any>;
}

export interface FieldSchema {
  fields: FieldDef[];
  groups?: FieldGroup[];
}

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'table';
  required?: boolean;
  placeholder?: string;
  help_text?: string;
  group?: string;
  columns?: string[];
}

export interface FieldGroup {
  key: string;
  label: string;
}

export interface DocGenRun {
  id: string;
  doc_type_id: string;
  fields_snapshot: Record<string, any>;
  output_file_token: string;
  status: 'generating' | 'success' | 'failed';
  error_message?: string;
  generated_by: 'form' | 'ai';
  created_at: string;
}
