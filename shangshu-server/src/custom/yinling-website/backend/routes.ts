// /api/website/* 转发路由（定制层）：透传官网 API，错误归一成 { error, kind }。
// 上游路径常量以 Task 1 探测文档为准——若线上实际路径不同，改这里一处即可。
import { Router } from 'express';
import type { Request, Response } from 'express';
import { websiteApi, WebsiteError } from './client.ts';

// —— 上游路径常量（探测文档：docs/superpowers/specs/2026-07-23-官网接口探测.md）——
const UP = {
  statsDaily: '/api/stats/daily',
  statsMonthly: '/api/stats/monthly',
  funnel: (period: string) => `/api/stats/funnel?period=${encodeURIComponent(period)}`,
  submissions: '/api/ai/submissions',
  submission: (id: string) => `/api/ai/submissions/${encodeURIComponent(id)}`,
  approve: (id: string) => `/api/ai/submissions/${encodeURIComponent(id)}/approve`,
  reject: (id: string) => `/api/ai/submissions/${encodeURIComponent(id)}/reject`,
  messages: '/api/contact/messages',   // 线上无 /api/harness/sessions（探测结论）
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function handleErr(e: unknown, res: Response): void {
  if (e instanceof WebsiteError) {
    const status = e.kind === 'NOT_CONFIGURED' ? 503 : e.kind === 'OFFLINE' ? 503 : 502;
    res.status(status).json({ error: e.message, kind: e.kind });
    return;
  }
  res.status(500).json({ error: (e as Error).message, kind: 'UPSTREAM' });
}

export function websiteRouter(): Router {
  const r = Router();
  const get = (path: string, up: (req: Request) => string) =>
    r.get(path, async (req, res) => {
      try { res.json(await websiteApi('GET', up(req))); } catch (e) { handleErr(e, res); }
    });

  get('/stats/daily', () => UP.statsDaily);
  get('/stats/monthly', () => UP.statsMonthly);
  get('/funnel', (req) => UP.funnel(String(req.query.period || 'month')));
  get('/submissions', () => UP.submissions);
  get('/submissions/:id', (req) => UP.submission(req.params.id));
  get('/messages', () => UP.messages);

  // 聚合：stat 卡一次拿齐（daily 今日/昨日 + 今日留言数 + 待审批数）
  r.get('/overview', async (_req, res) => {
    try {
      const [daily, messages, submissions] = await Promise.all([
        websiteApi<{ visits?: Record<string, number>; uniqueVisitors?: Record<string, number>; submissions?: Record<string, number> }>('GET', UP.statsDaily),
        websiteApi<any[]>('GET', UP.messages),
        websiteApi<any[]>('GET', UP.submissions),
      ]);
      const t = today();
      const dates = Object.keys(daily.visits || {}).sort();
      const yesterday = dates.filter(d => d < t).pop() || t;
      res.json({
        todayVisits: daily.visits?.[t] ?? 0,
        todayUnique: daily.uniqueVisitors?.[t] ?? 0,
        todaySubmissions: daily.submissions?.[t] ?? 0,
        yesterdayVisits: daily.visits?.[yesterday] ?? 0,
        todayMessages: (Array.isArray(messages) ? messages : []).filter(m => String(m.created_at || '').startsWith(t)).length,
        pendingCount: (Array.isArray(submissions) ? submissions : []).filter(s => s.status === 'pending').length,
      });
    } catch (e) { handleErr(e, res); }
  });

  const put = (path: string, up: (req: Request) => string) =>
    r.put(path, async (req, res) => {
      try { res.json(await websiteApi('PUT', up(req), req.body ?? {})); } catch (e) { handleErr(e, res); }
    });
  put('/submissions/:id/approve', (req) => UP.approve(req.params.id));
  put('/submissions/:id/reject', (req) => UP.reject(req.params.id));
  return r;
}
