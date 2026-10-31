import type { Router } from 'express';
import { readPlatformService } from '../../adapters/web/platform.ts';
import { suggestEvidence } from './evidence-assist.ts';

export function mountRecruitmentRoutes(router: Router) {
  router.post('/api/platform/recruitment/evidence-assist', async (req, res) => {
    try {
      const application = req.body?.application, source = req.body?.source_text;
      if (typeof application !== 'string' || !application.trim() || typeof source !== 'string' || !source.trim() || Array.from(source).length > 100000) {
        res.status(400).json({ ok: false, error: '请提供申请编号与不超过 100000 字符的原文' });
        return;
      }
      // Auth/domain/enterprise/job permissions are enforced before any model call.
      const context = await readPlatformService(req, 'recruitment.evidence.context', { application });
      const result = await suggestEvidence(context.snapshot.criteria, source);
      res.json({ ok: true, ...result, context_hash: context.context_hash });
    } catch (error: any) {
      res.status(error.status || 502).json({ ok: false, code: error.code || 'EVIDENCE_ASSIST_UNAVAILABLE',
        error: error.status ? '无法读取当前授权的招聘材料，请检查登录与岗位权限。' : 'AI 整理未完成；未保存任何事实，请人工整理或重试。' });
    }
  });
}
