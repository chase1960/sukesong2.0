// doc-gen REST API 路由
import { Router } from 'express';
import type { Context } from '../../core/types.ts';
import { DocGenService } from './service.ts';
import { docGenCompile } from './compiler.ts';
import { docGenValidate } from './validator.ts';
import { docGenPrefill } from './prefill.ts';

export function docGenRouter(createCtx: () => Context): Router {
  const router = Router();

  // —— 模板集 CRUD ——

  // GET /template-sets
  router.get('/template-sets', async (_req, res) => {
    try {
      const ctx = createCtx();
      const svc = new DocGenService(ctx);
      const sets = await svc.listTemplateSets();
      res.json(sets);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // POST /template-sets
  router.post('/template-sets', async (req, res) => {
    try {
      const ctx = createCtx();
      const svc = new DocGenService(ctx);
      const set = await svc.createTemplateSet(req.body);
      res.status(201).json(set);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // GET /template-sets/:id
  router.get('/template-sets/:id', async (req, res) => {
    try {
      const ctx = createCtx();
      const svc = new DocGenService(ctx);
      const set = await svc.getTemplateSet(req.params.id);
      if (!set) return res.status(404).json({ error: '模板集不存在' });
      const docTypes = await svc.listDocumentTypes(set.id);
      res.json({ ...set, doc_types: docTypes });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // POST /template-sets/:id/doc-types
  router.post('/template-sets/:id/doc-types', async (req, res) => {
    try {
      const ctx = createCtx();
      const svc = new DocGenService(ctx);
      const docType = await svc.createDocumentType({
        template_set_id: req.params.id,
        ...req.body,
      });
      res.status(201).json(docType);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // —— 文档类型 ——

  // POST /doc-types/:id/upload-template
  router.post('/doc-types/:id/upload-template', async (req, res) => {
    try {
      const ctx = createCtx();
      const svc = new DocGenService(ctx);
      const { base64, filename } = req.body;
      if (!base64) return res.status(400).json({ error: '缺少 base64' });

      const buffer = Buffer.from(base64, 'base64');
      const name = filename || 'template.docx';
      const { token } = await ctx.file.upload(name, buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      await svc.updateDocumentType(req.params.id, { template_file_token: token });
      res.json({ ok: true, file_token: token });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // GET /doc-types/:id
  router.get('/doc-types/:id', async (req, res) => {
    try {
      const ctx = createCtx();
      const svc = new DocGenService(ctx);
      const docType = await svc.getDocumentType(req.params.id);
      if (!docType) return res.status(404).json({ error: '文档类型不存在' });
      res.json(docType);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // PATCH /doc-types/:id
  router.patch('/doc-types/:id', async (req, res) => {
    try {
      const ctx = createCtx();
      const svc = new DocGenService(ctx);
      await svc.updateDocumentType(req.params.id, req.body);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // —— 生成文档 ——

  // POST /generate
  router.post('/generate', async (req, res) => {
    try {
      const ctx = createCtx();
      const svc = new DocGenService(ctx);
      const { doc_type_id, fields, generated_by } = req.body;

      // 1. 校验 doc type 存在且有模板
      const docType = await svc.getDocumentType(doc_type_id);
      if (!docType) return res.status(400).json({ error: '文档类型不存在' });
      if (!docType.template_file_token) return res.status(400).json({ error: '文档类型未配置模板' });

      // 2. 创建 generating 状态的 run
      const run = await svc.createRun({
        doc_type_id,
        fields_snapshot: fields,
        output_file_token: '',
        status: 'generating',
        generated_by: generated_by || 'form',
      });

      try {
        // 3. 调用 doc-gen.compile
        const result = await docGenCompile.run({
          template_file_token: docType.template_file_token,
          doc_type: docType.doc_key,
          fields,
        }, ctx);

        // 4. 成功则更新 run 为 success 并返回文件
        await svc.updateRun(run.id, {
          status: 'success',
          output_file_token: result.file_token,
        });

        res.json({ ok: true, run_id: run.id, file_token: result.file_token, file_name: result.file_name });
      } catch (e) {
        // 5. 失败则更新为 failed 并返回 500 JSON
        await svc.updateRun(run.id, {
          status: 'failed',
          error_message: (e as Error).message,
        });
        res.status(500).json({ error: (e as Error).message, run_id: run.id });
      }
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // —— 校验 ——

  // POST /validate
  router.post('/validate', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await docGenValidate.run(req.body, ctx);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // —— 预填 ——

  // POST /prefill
  router.post('/prefill', async (req, res) => {
    try {
      const ctx = createCtx();
      const result = await docGenPrefill.run(req.body, ctx);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
