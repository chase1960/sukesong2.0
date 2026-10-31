// 定制模块唯一对外契约（开发约定 §13）：register* 接入，不改 core。
import { registerRoute, registerDashboardWidget } from '../../core/registry.ts';
import { websiteRouter } from './backend/routes.ts';
import { websiteAdminProxy, websiteApiProxy, websiteUploadsProxy } from './backend/proxy.ts';

export function registerYinlingWebsite(): void {
  registerRoute('/api/website', websiteRouter());
  registerRoute('/website-admin', websiteAdminProxy());
  registerRoute('/website-api', websiteApiProxy());
  registerRoute('/website-uploads', websiteUploadsProxy());

  registerDashboardWidget({ id: 'yinling.stat', title: '今天，官网替你接住了什么', template: 'stat', dataUrl: '/api/website/overview', size: 'lg', order: 10 });
  registerDashboardWidget({ id: 'yinling.funnel', title: '访问到留言，沙子停在哪一层', template: 'funnel', dataUrl: '/api/website/funnel?period=month', size: 'md', order: 20 });
  registerDashboardWidget({ id: 'yinling.line', title: '近 30 天访问趋势', template: 'line', dataUrl: '/api/website/stats/daily', size: 'md', order: 30 });
  registerDashboardWidget({ id: 'yinling.donut', title: '提交都来自哪些模块', template: 'donut', dataUrl: '/api/website/submissions', size: 'md', order: 40 });
  registerDashboardWidget({ id: 'yinling.bars', title: '这一年的访问，都堆在几月', template: 'bars', dataUrl: '/api/website/stats/monthly', size: 'md', order: 50 });
}
