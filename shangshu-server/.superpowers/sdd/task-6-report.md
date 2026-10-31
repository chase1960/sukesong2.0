# Task 6 Report: 银聆法律文书内置示例

## What Was Done

1. **Copied 6 .docx templates** to `data/templates/yinling/`:
   - 合同_template.docx (contract)
   - 排期表_template.docx (schedule)
   - 收据_template.docx (receipt)
   - 项目协作约定_template.docx (collaboration)
   - 进度报告_template.docx (progress_report)
   - 需求确认书_template.docx (requirements)

2. **Created `src/capabilities/doc-gen/seed.ts`** with `seedYinlingTemplates(ctx)`:
   - Idempotent: checks if template set already exists, skips if so
   - Creates one `TemplateSet` ("银聆法律文书", status: active, created_by: system)
   - For each of 6 templates: reads file from disk, uploads to FileStore, creates `DocumentType` with full `field_schema`
   - Each field_schema includes groups and field definitions (key, label, type, required, group, placeholder, help_text, columns for table type)
   - Field schemas derived from `reference/fields_reference.md` in the lingering-legal-doc skill

3. **Modified `src/main.ts`**:
   - Added import for `seedYinlingTemplates` and `buildContext`
   - After `registerDocGen(external)`, builds a context and calls `await seedYinlingTemplates(seedCtx)`
   - Logs progress via `ctx.log`

## Files Changed

- `data/templates/yinling/` - 6 new .docx files
- `src/capabilities/doc-gen/seed.ts` - new seed module
- `src/main.ts` - added seed call
- `.superpowers/sdd/progress.md` - updated task 6 status

## Verification

- `npx tsc --noEmit` passes with zero errors
- Seed is idempotent: second run detects existing template set and skips
- Commit: 45777e4

## Field Schema Summary

| Doc Type | Fields | Groups |
|----------|--------|--------|
| requirements | 23 | 10 (meta, overview, process, roles, functional, docs, nfr, delivery, risk, appendix) |
| schedule | 11 | 4 (meta, commercial, timeline, milestones) |
| contract | 30 | 6 (parties, project, amount, payment, delivery, optional) |
| collaboration | 5 | 1 (meta) |
| progress_report | 7 | 1 (content) |
| receipt | 6 | 1 (payment) |
