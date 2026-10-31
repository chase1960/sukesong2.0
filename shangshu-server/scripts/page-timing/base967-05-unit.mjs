/* BASE967-05 纯逻辑单测（零依赖）：复制 mail-center.js 里的 replyTarget + uniqueAcross（修后版），
   跑 BASE967-05 修后应有的行为 + 修前会红的行为作证伪。 */
const parseRecipients = (s) => ({list: (s||'').split(/[,;]\s*/).map(x => x.trim()).filter(x => x)});
function uniqueAcross(list, ...extras) {
  const seen = new Set();
  const out = [];
  for (const arr of [list, ...extras]) {
    for (const x of arr || []) {
      const key = String(x).trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
  }
  return out;
}
/* === 修后版 === replyTarget() 在 mail-center.js:970-974；uniqueAcross 在 :953-963 */
function replyTarget_v2(m, selfAddresses = new Set()) {
  const rt = parseRecipients(m.replyToAddress || '').list;
  if (rt.length) return rt;
  return selfAddresses.has(String(m.from.addr).trim().toLowerCase()) ? (m.to || []) : [m.from];
}
/* mail-center.js:986 的 reply-all 用法（修后）：replyTarget() 当主项 */
function replyAllTo_v2(m, selfAddresses = new Set()) {
  const [to, cc] = uniqueAcross([replyTarget_v2(m, selfAddresses), ...(m.to || [])], m.cc || []);
  return {to, cc};
}

/* === 修前版 === */
function replyTarget_v1(m, selfAddresses = new Set()) {
  const rt = parseRecipients(m.replyToAddress || '').list;
  if (rt.length) return rt;
  return selfAddresses.has(String(m.from.addr).trim().toLowerCase()) ? (m.to || []) : [m.from];
}
/* mail-center.js 修前 reply-all 是 [m.from, ...m.to] */
function replyAllTo_v1(m, selfAddresses = new Set()) {
  // m.from 自身是 {addr,...} 数组形式传进 uniqueAcross 会展平；这里按 uniqueAcross 真行为模拟
  const [to, cc] = uniqueAcross([m.from, ...(m.to || [])], m.cc || []);
  return {to, cc};
}

const m = {
  from: {addr: 'sender0@x.invalid'},
  from_address: 'sender0@x.invalid',
  replyToAddress: 'reply@example.invalid',
  to: ['other@x.invalid'],
  cc: ['cc1@x.invalid'],
};

/* 修后期望：reply-all To 含 Reply-To，不含 m.from */
const v2 = replyAllTo_v2(m);
const v2_ok = v2.to.includes('reply@example.invalid') && !v2.to.includes('sender0@x.invalid');
console.log(`修后 reply-all to=${JSON.stringify(v2.to)} ${v2_ok ? 'OK ✅' : 'FAIL ✖'}`);

/* 修前应红：reply-all To 用 m.from（不含 Reply-To） */
const v1 = replyAllTo_v1(m);
/* v1.to 实际是对象 {addr:'sender0@x.invalid'}（uniqueAcross 拿 m.from 对象展平）——
   检查 v1.to 里有没有含 reply@example.invalid + 是否含 sender0@x.invalid（字符串版） */
const v1HasReply = (JSON.stringify(v1.to) || '').includes('reply@example.invalid');
const v1HasSender = (JSON.stringify(v1.to) || '').includes('sender0@x.invalid');
const v1_fails = !v1HasReply && v1HasSender;
console.log(`修前 reply-all to=${JSON.stringify(v1.to)} ${v1_fails ? '会红 ✅' : '不应通过 ✖'}`);

if (!v2_ok || !v1_fails) {
  console.error('BASE967-05 单测失败');
  process.exit(1);
}
