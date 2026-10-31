/* ============ 模块：定时任务 ============ */
const FREQ_PRESETS = [
  { cron: '*/5 * * * *', label: '每 5 分钟' },
  { cron: '*/10 * * * *', label: '每 10 分钟' },
  { cron: '*/30 * * * *', label: '每 30 分钟' },
  { cron: '0 * * * *', label: '每 1 小时' },
  { cron: '0 */6 * * *', label: '每 6 小时' },
  { cron: '0 0 * * *', label: '每天 0 点' },
];
const freqLabel = (c) => (FREQ_PRESETS.find(p => p.cron === c) || {}).label;
const isPreset = (c) => FREQ_PRESETS.some(p => p.cron === c);
// 任何 cron 都翻成人话，界面永远不暴露原始 cron 表达式
const cronHuman = (c) => {
  const p = FREQ_PRESETS.find(x => x.cron === c); if (p) return p.label;
  let m = c.match(/^\*\/(\d+) \* \* \* \*$/); if (m) return `每 ${m[1]} 分钟`;
  if (/^0 \* \* \* \*$/.test(c)) return '每小时整点';
  m = c.match(/^0 \*\/(\d+) \* \* \*$/); if (m) return `每 ${m[1]} 小时`;
  m = c.match(/^(\d+) (\d+) \* \* \*$/); if (m) return `每天 ${m[2]}:${m[1].padStart(2, '0')}`;
  return '自定义计划';
};

// 触发器 id 含点（trigger.invoice-poll），CSS 选择器里点会被当成 class 分隔符，
// 所以 DOM id / 选择器统一用 sid() 把点换成横线；API 调用仍用原始 id。
const sid = (id) => id.replace(/\./g, '-');

RENDER.tasks = async function () {
  const triggers = await apiJSON('api/triggers');
  let html = `<div class="page-hd page-heading"><h1>定时任务</h1></div>`;
  for (const t of triggers) {
    const runs = await apiJSON('api/triggers/' + t.id + '/runs');
    const log = runs.slice(0, 6).map(r => `<div class="cron-log-item"><span class="cron-log-time">${dt(r.started_at)}</span><span class="cron-log-msg">${r.status === 'done' ? '✓' : '✗'} 收 ${r.collected} · 新增 ${r.added} · 重复 ${r.duplicate} · 失败 ${r.failed}</span></div>`).join('') || `<div class="cron-log-item"><span class="cron-log-msg" style="color:var(--fg3)">还没有运行记录</span></div>`;
    html += `
      <div class="cron-card">
        <div class="cron-ico" style="background:linear-gradient(135deg,#1B3A2D,#2E5E4E)">${ICONS[t.id.includes('inv') ? 'receipt' : 'clock']}</div>
        <div class="cron-info">
          <div class="cron-name">${t.name}</div>
          <div class="cron-desc">${t.description}</div>
          <div class="cron-next">频率：<b>${cronHuman(t.schedule)}</b> · 上次：${t.last_run_at ? dt(t.last_run_at) : '尚未运行'}</div>
        </div>
        <div class="cron-status"><span class="cron-dot ${t.enabled ? 'on' : 'off'}"></span><span class="cron-label">${t.enabled ? '运行中' : '已暂停'}</span></div>
        <div class="cron-acts"><button class="btn btn-pri" onclick="runNow('${t.id}')">立即运行</button><button class="cron-toggle ${t.enabled ? 'on' : ''}" onclick="toggleTrig('${t.id}',${!t.enabled})" title="启用/停用"></button></div>
      </div>

      <div class="card" style="margin-top:-4px;margin-bottom:14px">
        <div class="card-hd"><span class="t">运行设置</span><span class="more">改完点「保存设置」生效</span></div>
        <div class="card-bd">
          <div class="fld"><label>多久查一次邮箱？</label>
            <div class="freq" id="freq-${sid(t.id)}">
              ${FREQ_PRESETS.map(p => `<button class="${p.cron === t.schedule ? 'on' : ''}" data-c="${p.cron}" onclick="pickFreq('${t.id}','${p.cron}')">${p.label}</button>`).join('')}
            </div>
            <div class="hint" id="freq-hint-${sid(t.id)}">${isPreset(t.schedule) ? '系统按这个频率自动查收邮箱里的发票。' : '当前计划：' + cronHuman(t.schedule) + '，选一个频率点「保存设置」即可。'}</div>
          </div>
          <div class="fld"><label>收件邮箱 <span style="color:var(--fg3);font-weight:normal">（agently 模式才填；folder 演示模式忽略）</span></label><input id="mail-${sid(t.id)}" value="${t.params?.mailbox || ''}" placeholder="如 invoice@公司域名"><div class="hint">把邮件源切到 agently 并填这个邮箱后，才会真去查收。</div></div>
          <button class="btn btn-pri" onclick="saveTrig('${t.id}')">保存设置</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-hd"><span class="t">执行记录</span></div>
        <div class="card-bd"><div class="cron-log">${log}</div></div>
      </div>`;
  }
  html += `<div class="ai-note"><span class="spark">✦</span><span>「发票收集」= 定时查邮箱的<b>数字员工</b>。邮件源现在是 <b>folder（演示）</b>；到「系统配置」切到 agently 并补齐凭证，就真正上线。</span></div>`;
  mainBox().innerHTML = html;
};
function pickFreq(id, cron) {
  $$('#freq-' + sid(id) + ' button').forEach(b => b.classList.toggle('on', b.dataset.c === cron));
  $('#freq-hint-' + sid(id)).textContent = '系统按这个频率自动查收邮箱里的发票。';
}
async function runNow(id) { toast('运行中…'); const r = await api('api/triggers/' + id + '/run', { method: 'POST' }); const j = await r.json(); toast(j.status === 'done' ? `完成：新增 ${j.added} · 重复 ${j.duplicate}` : '失败', j.status === 'done' ? `收 ${j.collected} · 失败 ${j.failed}` : ''); RENDER.tasks(); }
async function toggleTrig(id, on) { await api('api/triggers/' + id, { method: 'PATCH', body: JSON.stringify({ enabled: on }) }); toast(on ? '已启用' : '已暂停'); RENDER.tasks(); }
async function saveTrig(id) {
  const schedule = $('#freq-' + sid(id) + ' button.on')?.dataset.c || '*/10 * * * *';
  const mailbox = $('#mail-' + sid(id)).value.trim();
  await api('api/triggers/' + id, { method: 'PATCH', body: JSON.stringify({ schedule, params: { mailbox } }) });
  toast('已保存', '频率：' + freqLabel(schedule)); RENDER.tasks();
}
