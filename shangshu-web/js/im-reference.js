/* ==========================================================================
   消息 · 目标样式参考（im-ref）
   ==========================================================================
   ⚠ 本文件是「消息」模块的目标样式副本，开发真实消息模块时对照它做，
   不要改这里。访问方式：#/im-ref（不进侧栏）。
   原版 mock 在 erp-mock.js（RENDER['im']），本副本全部函数/数据加 imRef 前缀隔离。
   ========================================================================== */
const IM_REF_CONTACTS = [
  { id: 'chen', name: '陈晓', role: '销售', color: '#2E5E4E', avatar: '陈' },
  { id: 'wang', name: '王强', role: '生产主管', color: '#8A5A2B', avatar: '王' },
  { id: 'li', name: '李婷', role: '销售', color: '#4A78B8', avatar: '李' },
  { id: 'sun', name: '孙总', role: '老板', color: '#1B3A2D', avatar: '孙' },
  { id: 'fang', name: '王芳', role: '财务', color: '#B45309', avatar: '芳' },
];
function imRefGetContact(id) { return IM_REF_CONTACTS.find(c => c.id === id); }

const IM_REF_CHATS = [
  { id: 'g-sales', type: 'group', name: '销售部', members: ['chen', 'li', 'sun'], unread: 2, role: ['staff', 'boss'] },
  { id: 'g-prod', type: 'group', name: '生产部', members: ['wang', 'sun'], unread: 0, role: ['prod', 'boss'] },
  { id: 'g-all', type: 'group', name: '银舟全员', members: ['chen', 'wang', 'li', 'sun', 'fang'], unread: 5, role: ['staff', 'prod', 'boss'] },
  { id: 'dm-sun-chen', type: 'dm', peer: 'chen', unread: 1, role: ['staff', 'boss'] },
  { id: 'dm-chen-wang', type: 'dm', peer: 'wang', unread: 0, role: ['staff', 'prod', 'boss'] },
  { id: 'dm-sun-wang', type: 'dm', peer: 'wang', unread: 0, role: ['prod', 'boss'] },
];
function imRefGetChats() { return IM_REF_CHATS.filter(c => c.role.includes(DEMO_ROLE)); }

const IM_REF_MESSAGES = {
  'g-sales': [
    { from: 'chen', text: '恒泰的报价单我已经改好了，9 折 + 税额单独标注', time: '09:15', ai: false },
    { from: 'li', text: '收到，蓝海那边周工还没回我，我下午再跟一下', time: '09:18', ai: false },
    { from: 'sun', text: '陈晓，恒泰 7/31 合同到期，这周必须推进签约', time: '09:22', ai: false },
    { from: 'chen', text: '收到孙总，今天下午约了孙立面谈', time: '09:24', ai: false },
    { from: 'ai', text: '✦ 系统提示：恒泰贸易报价单 v3 已生成，待陈晓确认后发送', time: '09:25', ai: true },
    { from: 'li', text: '对了，云启物流那边首次电话聊得还行，对方想先试用一个月', time: '09:40', ai: false },
    { from: 'chen', text: '试用版可以走，但要提前说好年付价格锁定，别试完跑了', time: '09:42', ai: false },
    { from: 'sun', text: '同意，试用合同里加一条：试用期结束 7 天内签年付，否则恢复原价', time: '09:45', ai: false },
    { from: 'ai', text: '✦ 系统提示：云启物流试用合同模板已生成，含「试用转年付锁定条款」', time: '09:47', ai: true },
  ],
  'g-prod': [
    { from: 'wang', text: 'MO-0715 缺料问题确认了，B 料供应商那边要 7/20 才能到', time: '08:30', ai: false },
    { from: 'sun', text: '那 MO-0712 先不等了，正常推进', time: '08:35', ai: false },
    { from: 'wang', text: '明白，MO-0712 今天下午完成最终质检', time: '08:38', ai: false },
    { from: 'wang', text: '另外 MO-0715 的 A 料库存还有 3 天余量，够撑到 B 料到货', time: '08:42', ai: false },
    { from: 'sun', text: '好，7/20 到货后第一时间安排 MO-0715 复工', time: '08:45', ai: false },
    { from: 'ai', text: '✦ 系统提示：PO-0098 采购单已确认，预计 7/20 到货', time: '08:47', ai: true },
    { from: 'wang', text: '收到。还有个事，7 月底要做库存盘点，我先让小李准备盘点表', time: '09:00', ai: false },
    { from: 'sun', text: '行，盘点完出一份差异报告给我', time: '09:05', ai: false },
  ],
  'g-all': [
    { from: 'sun', text: '各位，本周五下午 3 点开经营周会，请准备好各自的数据', time: '08:00', ai: false },
    { from: 'chen', text: '收到，我准备恒泰和蓝海的进展报告', time: '08:05', ai: false },
    { from: 'wang', text: '生产部这边 MO-0712 和 MO-0715 的进度我来汇报', time: '08:08', ai: false },
    { from: 'fang', text: '财务提醒：本月应付账款 ¥86,000 需在 7/31 前结清', time: '08:12', ai: false },
    { from: 'ai', text: '✦ 系统提示：周会日程已同步到各位日历，议题清单已发群文件', time: '08:15', ai: true },
    { from: 'li', text: '王芳，蓝海的试用款能走加急吗？', time: '08:20', ai: false },
    { from: 'fang', text: '可以，走正常报销流程我今天处理', time: '08:22', ai: false },
    { from: 'chen', text: '补充一下：恒泰那边如果这周签约成功，Q3 营收目标就稳了', time: '08:30', ai: false },
    { from: 'wang', text: '生产这边也没问题，MO-0712 明天出货，MO-0715 月底前补上', time: '08:33', ai: false },
    { from: 'sun', text: '很好，周五见。另外提醒一下，7/31 是恒泰合同到期日，也是应付账款截止日，两件事别撞了', time: '08:36', ai: false },
    { from: 'fang', text: '明白，我提前催一下永鑫那边的回款', time: '08:38', ai: false },
  ],
  'dm-sun-chen': [
    { from: 'sun', text: '陈晓，恒泰那边什么情况？', time: '09:00', ai: false },
    { from: 'chen', text: '孙总，昨天和孙立通了电话，他对 9 折方案基本认可，但要求发票单独开', time: '09:05', ai: false },
    { from: 'sun', text: '可以，发票让王芳单独处理。这周能签吗？', time: '09:08', ai: false },
    { from: 'chen', text: '我今天下午去面谈，争取周五前搞定', time: '09:10', ai: false },
    { from: 'ai', text: '✦ AI 建议：恒泰合同 7/31 到期，建议本周签约避免跨月账期风险', time: '09:12', ai: true },
    { from: 'sun', text: '另外，蓝海那边什么态度？', time: '09:20', ai: false },
    { from: 'chen', text: '周工对价格有点犹豫，想再比比价。不过我们产品质量他认可', time: '09:23', ai: false },
    { from: 'sun', text: '那就先给他试用，用了之后他就知道差距了', time: '09:25', ai: false },
    { from: 'chen', text: '明白，我下午一起跟他说', time: '09:27', ai: false },
  ],
  'dm-chen-wang': [
    { from: 'chen', text: '王强，MO-0712 什么时候能出货？客户在催', time: '11:00', ai: false },
    { from: 'wang', text: '今天下午质检完，明天上午可以安排发货', time: '11:05', ai: false },
    { from: 'chen', text: '好的，我跟客户确认收货地址', time: '11:08', ai: false },
    { from: 'wang', text: '对了，MO-0715 的 B 料 7/20 到，到之前我先把 MO-0712 的尾数清完', time: '11:15', ai: false },
    { from: 'chen', text: '行，辛苦了。客户那边我盯着', time: '11:18', ai: false },
    { from: 'wang', text: '不辛苦，你那边恒泰签约顺利的话，我们排产也好安排', time: '11:20', ai: false },
  ],
  'dm-sun-wang': [
    { from: 'sun', text: '王强，MO-0715 断料的事怎么处理？', time: '14:00', ai: false },
    { from: 'wang', text: '孙总，B 料 7/20 到，到之前先排 MO-0712 的工序，不耽误出货', time: '14:05', ai: false },
    { from: 'sun', text: '行，你来安排，有问题随时说', time: '14:08', ai: false },
    { from: 'ai', text: '✦ AI 建议：MO-0715 排产建议顺延至 7/22，优先保障 MO-0712 交付', time: '14:10', ai: true },
    { from: 'wang', text: '收到，我还想问一下，7 月底的库存盘点您有什么特别关注的品类吗？', time: '14:15', ai: false },
    { from: 'sun', text: '重点关注 B 料和成品库存，特别是恒泰的定制件', time: '14:18', ai: false },
    { from: 'wang', text: '明白，我让小李重点盯这几项', time: '14:20', ai: false },
  ],
};

const IM_REF_ROLE_MAP = { staff: 'chen', prod: 'wang', boss: 'sun' };
let imRefCurChat = null;
function imRefRender() {
  const chats = imRefGetChats();
  if (!imRefCurChat) imRefCurChat = chats[0]?.id;
  const msgs = IM_REF_MESSAGES[imRefCurChat] || [];
  const activeChat = IM_REF_CHATS.find(c => c.id === imRefCurChat);

  // 左栏：会话列表
  let listHtml = '';
  chats.forEach((c, i) => {
    const lastMsg = (IM_REF_MESSAGES[c.id] || []).slice(-1)[0];
    const preview = lastMsg ? lastMsg.text.slice(0, 28) + (lastMsg.text.length > 28 ? '…' : '') : '';
    const time = lastMsg ? lastMsg.time : '';
    let avatarHtml;
    if (c.type === 'group') {
      const members = c.members.slice(0, 3).map(id => { const m = imRefGetContact(id); return `<span style="display:inline-block;width:14px;height:14px;border-radius:2px;background:${m.color};color:#fff;font-size:7px;text-align:center;line-height:14px;">${m.avatar}</span>`; }).join('');
      avatarHtml = `<div class="im-av-group">${members}</div>`;
    } else {
      const p = imRefGetContact(c.peer);
      avatarHtml = `<div class="im-av" style="background:${p.color}">${p.avatar}</div>`;
    }
    listHtml += `
      <div class="im-item ${c.id === imRefCurChat ? 'on' : ''}" onclick="imRefOpenChat('${c.id}')" style="animation-delay:${i * .04}s">
        ${avatarHtml}
        <div class="im-item-info">
          <div class="im-item-top">
            <span class="im-item-name">${c.type === 'group' ? c.name : imRefGetContact(c.peer).name}</span>
            <span class="im-item-time">${time}</span>
          </div>
          <div class="im-item-preview">${preview}</div>
        </div>
        ${c.unread ? `<span class="im-unread">${c.unread}</span>` : ''}
      </div>`;
  });

  // 右栏：消息
  let msgsHtml = '';
  if (activeChat) {
    const chatName = activeChat.type === 'group' ? activeChat.name : imRefGetContact(activeChat.peer).name;
    const memberInfo = activeChat.type === 'group'
      ? `${activeChat.members.length} 名成员`
      : imRefGetContact(activeChat.peer).role;
    msgsHtml = `
      <div class="im-hd">
        <div class="im-hd-info">
          <div class="im-hd-name">${chatName}</div>
          <div class="im-hd-sub">${memberInfo}</div>
        </div>
        ${activeChat.type === 'group' ? `<button class="btn btn-ghost" onclick="toast('群设置','演示环境，可管理成员和群名')">群设置</button>` : ''}
      </div>
      <div class="im-msgs" id="im-msgs">`;
    msgs.forEach((m, i) => {
      if (m.ai) {
        msgsHtml += `
          <div class="im-msg im-ai" style="animation-delay:${i * .05}s">
            <div class="im-ai-tag">✦ 系统</div>
            <div class="im-bubble ai">${m.text}</div>
            <div class="im-msg-time">${m.time}</div>
          </div>`;
      } else {
        const sender = imRefGetContact(m.from);
        const isMe = m.from === IM_REF_ROLE_MAP[DEMO_ROLE];
        msgsHtml += `
          <div class="im-msg ${isMe ? 'self' : ''}" style="animation-delay:${i * .05}s">
            ${!isMe ? `<div class="im-av sm" style="background:${sender.color}">${sender.avatar}</div>` : ''}
            <div class="im-msg-body">
              ${!isMe ? `<div class="im-msg-name">${sender.name}</div>` : ''}
              <div class="im-bubble">${m.text}</div>
              <div class="im-msg-time">${m.time}</div>
            </div>
            ${isMe ? `<div class="im-av sm" style="background:${sender.color}">${sender.avatar}</div>` : ''}
          </div>`;
      }
    });
    msgsHtml += `</div>
      <div class="im-input">
        <div class="im-input-bar">
          <button class="ib-btn" title="表情" onclick="toast('表情','演示环境')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/></svg></button>
          <button class="ib-btn" title="文件" onclick="toast('文件','演示环境')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M14.5 3.5h6v6M14.5 9.5L21 3M10 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9.5"/></svg></button>
          <button class="ib-btn" title="图片" onclick="toast('图片','演示环境')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="3.5" width="18" height="17" rx="1.5"/><circle cx="8.5" cy="9" r="2.2"/><path d="M21 16l-5-5-4 4-3-3-6 6"/></svg></button>
        </div>
        <div class="im-input-box">
          <input type="text" id="im-input" placeholder="输入消息…" onkeydown="if(event.key==='Enter')imRefSendMsg()">
          <button class="send-btn" onclick="imRefSendMsg()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3L3 10.3l7.2 2.7L12.9 21z"/><path d="M21 3L10.2 13"/></svg></button>
        </div>
      </div>`;
  }

  mainBox().innerHTML = `
    <div class="im-layout">
      <div class="im-list">
        <div class="im-list-hd">
          <span>消息 <span class="tag am" style="font-size:9px;vertical-align:2px">参考</span></span>
          <button class="im-add-btn" onclick="imRefOpenNewGroup()" title="新建群聊">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
        ${listHtml}
      </div>
      <div class="im-chat">
        ${msgsHtml || '<div class="im-empty">选择一个会话开始聊天</div>'}
      </div>
    </div>
    <div class="im-modal" id="im-modal" style="display:none" onclick="if(event.target===this)imRefCloseNewGroup()">
      <div class="im-modal-box">
        <div class="im-modal-hd">新建群聊</div>
        <div class="im-modal-bd">
          <label class="im-label">群名称</label>
          <input type="text" id="new-group-name" class="im-input-field" placeholder="输入群名…">
          <label class="im-label" style="margin-top:12px">添加成员</label>
          <div class="im-member-list">
            ${IM_REF_CONTACTS.map(c => `
              <label class="im-member-check">
                <input type="checkbox" value="${c.id}">
                <div class="im-av sm" style="background:${c.color}">${c.avatar}</div>
                <span>${c.name}</span>
                <span class="im-member-role">${c.role}</span>
              </label>`).join('')}
          </div>
        </div>
        <div class="im-modal-ft">
          <button class="btn btn-ghost" onclick="imRefCloseNewGroup()">取消</button>
          <button class="btn btn-pri" onclick="imRefCreateGroup()">创建</button>
        </div>
      </div>
    </div>`;

  // 滚动到底部
  const msgsEl = document.getElementById('im-msgs');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
}

function imRefOpenChat(id) {
  imRefCurChat = id;
  const chat = IM_REF_CHATS.find(c => c.id === id);
  if (chat) chat.unread = 0;
  imRefRender();
}

function imRefSendMsg() {
  const input = document.getElementById('im-input');
  if (!input || !input.value.trim()) return;
  const text = input.value.trim();
  const me = IM_REF_ROLE_MAP[DEMO_ROLE];
  if (!IM_REF_MESSAGES[imRefCurChat]) IM_REF_MESSAGES[imRefCurChat] = [];
  IM_REF_MESSAGES[imRefCurChat].push({ from: me, text, time: '刚刚', ai: false });
  imRefRender();
  toast('消息已发送', text.length > 16 ? text.slice(0, 16) + '…' : text);
}

function imRefOpenNewGroup() { document.getElementById('im-modal').style.display = 'flex'; }
function imRefCloseNewGroup() { document.getElementById('im-modal').style.display = 'none'; }
function imRefCreateGroup() {
  const name = document.getElementById('new-group-name').value.trim();
  if (!name) { toast('请输入群名', ''); return; }
  const checks = document.querySelectorAll('.im-member-list input:checked');
  if (checks.length < 1) { toast('请选择至少一名成员', ''); return; }
  const members = Array.from(checks).map(c => c.value);
  if (!members.includes(IM_REF_ROLE_MAP[DEMO_ROLE])) members.push(IM_REF_ROLE_MAP[DEMO_ROLE]);
  const id = 'g-' + Date.now();
  IM_REF_CHATS.unshift({ id, type: 'group', name, icon: '💬', members, unread: 0, role: ['staff', 'prod', 'boss'] });
  IM_REF_MESSAGES[id] = [{ from: 'ai', text: `✦ 群聊「${name}」已创建`, time: '刚刚', ai: true }];
  imRefCloseNewGroup();
  imRefCurChat = id;
  toast('群聊已创建', name);
  imRefRender();
}

/* 注册：目标样式参考模块（不进侧栏，hash #/im-ref 直达） */
RENDER['im-ref'] = imRefRender;
