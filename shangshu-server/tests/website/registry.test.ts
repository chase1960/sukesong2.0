import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('dashboard / route 注册表', () => {
  it('registerDashboardWidget 后按 order 升序返回', async () => {
    const { registerDashboardWidget, listDashboardWidgets } = await import('../../src/core/registry.ts');
    registerDashboardWidget({ id: 't.b', title: 'B', template: 'stat', dataUrl: '/x', size: 'sm', order: 20 });
    registerDashboardWidget({ id: 't.a', title: 'A', template: 'stat', dataUrl: '/x', size: 'sm', order: 10 });
    const ids = listDashboardWidgets().map(w => w.id);
    assert.ok(ids.indexOf('t.a') < ids.indexOf('t.b'));
  });

  it('registerRoute 后可从 listRoutes 取回', async () => {
    const { registerRoute, listRoutes } = await import('../../src/core/registry.ts');
    const { Router } = await import('express');
    registerRoute('/api/test-website', Router());
    assert.ok(listRoutes().some(r => r.path === '/api/test-website'));
  });
});
