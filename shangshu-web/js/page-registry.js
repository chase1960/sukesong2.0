/* 尚书正式页面注册表。
   RENDER 只负责“如何画”，本表负责“这是不是正式产品页、由谁拥有、平台模式能否进入”。 */
(function (root) {
  const pages = {};
  const add = (ids, meta) => ids.forEach(id => { pages[id] = Object.freeze({ id, ...meta }); });

  add(['dash', 'applications', 'application', 'objects', 'flowdesign', 'chat', 'personal-settings'], {
    owner: 'com.shangshu.core', status: 'implemented', platform: true,
  });
  add(['app-design', 'apps', 'modules', 'ai-tools', 'accounts'], {
    owner: 'com.shangshu.core', status: 'implemented', platform: true, roles: ['admin'],
  });
  add(['task-mgmt', 'im'], {
    owner: 'com.shangshu.compat.collaboration', status: 'compatibility', platform: true,
  });
  // 员工工作面；入口不授予数据权限，服务端仍逐项判断域状态和原有权限。
  add(['file-center', 'mail', 'sheets'], {
    owner: 'com.shangshu.core', status: 'implemented', platform: true, roles: ['admin', 'staff', 'finance', 'manager'], capability: 'connected',
  });
  // 审核中心（PKG-033-T01）：**平台的一道公共闸门**，不是任何业务域的页 ——
  // 页面本体归核心域，域只注册**声明**（这一类审核怎么组织、显示什么、能不能部分保存、保存到哪去）。
  add(['review-center'], {
    owner: 'com.shangshu.core', status: 'implemented', platform: true, roles: ['admin', 'staff', 'finance', 'manager'],
  });
  add(['config'], {
    owner: 'com.shangshu.bff.integrations', status: 'compatibility', platform: true, roles: ['admin'],
  });

  add(['review', 'accounting', 'payables'], {
    owner: 'com.shangshu.compat.finance', status: 'retired', platform: false, alias: 'objects',
  });
  add(['users', 'workspaces', 'flows', 'tasks', 'customers', 'products', 'orders', 'purchase', 'inventory', 'delivery'], {
    owner: 'com.shangshu.legacy.node', status: 'retired', platform: false,
  });
  add(['skill-sync', 'doc-templates', 'doc-gen', 'appr', 'website'], {
    owner: 'com.shangshu.legacy.optional', status: 'compatibility', platform: false,
  });
  add(['projects', 'topics', 'sop', 'kanban', 'calendar', 'agents', 'im-ref', 'production', 'expense', 'docs', 'files', 'skills', 'tools-logo', 'tools-crawl', 'tools-site', 'tools-img'], {
    owner: 'com.shangshu.preview', status: 'mock', platform: false,
  });

  /* SHANGSHU_PAGE_REGISTRY 是快照（冻结）；pages 内部表可随域注册增长，注册后重建快照。 */
  const snapshot = () => { root.SHANGSHU_PAGE_REGISTRY = Object.freeze({ ...pages }); };
  snapshot();
  root.shangshuPageDefinition = id => pages[id] || null;
  /* —— 前端领域注册点（2026-09-24）：业务域页面动态注册，新域不改本文件 ——
     域 JS 经 js/domains/<域>/domain-entry.json 自动加载后调用：
       shangshuRegisterPages(['my-page'], { owner: 'com.example.mydomain', name: '我的页面' })
     页面 ID 已被其他 owner 注册时整批拒绝（防两个域抢同一页面 ID）。 */
  root.shangshuRegisterPages = (ids, meta) => {
    const owner = meta && typeof meta.owner === 'string' && meta.owner ? meta.owner : '';
    if (!owner) return { ok: false, reason: '缺少 owner 命名空间' };
    const taken = ids.filter(id => pages[id] && pages[id].owner !== owner);
    if (taken.length) return { ok: false, reason: '页面 ID 已被其他所有者注册：' + taken.join(',') };
    add(ids, { status: 'implemented', platform: true, ...meta, owner });
    snapshot();
    return { ok: true };
  };
  root.shangshuResolvePlatformPage = (id, role) => {
    const requested = pages[id];
    const targetId = requested?.alias || id;
    const target = pages[targetId];
    if (!target || !target.platform || !['implemented', 'compatibility'].includes(target.status)) return null;
    if (target.roles?.length && role !== 'admin' && !target.roles.includes(role)) return null;
    return targetId;
  };
})(window);
