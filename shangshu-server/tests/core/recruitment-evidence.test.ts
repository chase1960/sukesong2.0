import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvidence } from '../../src/capabilities/recruitment/evidence-assist.ts';
import { aiParseResume, aiGenerateJD, aiScreenApplication } from '../../src/capabilities/recruitment/ai.ts';
import { activePreferenceLines, extractSkillDrafts } from '../../src/capabilities/recruitment/skills.ts';
import { registerRecruitmentContracts } from '../../src/capabilities/recruitment/contracts.ts';
import { getActionContract } from '../../src/core/action-contracts.ts';

const criteria = [{ id: 'c1', criterion: '交付案例', required: true }, { id: 'c2', criterion: '带教', required: false }];
test('quoted evidence uses Unicode positions and never fills absent criteria', () => {
  const rows = normalizeEvidence(criteria, '😀完成交付', [{ criterion_id: 'c1', status: 'supported', citations: [{ start: 1, end: 5, quote: '完成交付' }] }]);
  assert.equal(rows[0].status, 'supported');
  assert.equal(rows[1].status, 'missing');
  assert.deepEqual(rows[1].citations, []);
});
test('invented, duplicate and out of bounds model citations become missing', () => {
  for (const citations of [[{ start: 0, end: 99, quote: '完成交付' }], [{ start: 0, end: 4, quote: '领导团队' }], []]) {
    assert.equal(normalizeEvidence(criteria, '完成交付', [{ criterion_id: 'c1', status: 'supported', citations }])[0].status, 'missing');
  }
  const row = { criterion_id: 'c1', status: 'supported', citations: [{ start: 0, end: 4, quote: '完成交付' }] };
  assert.equal(normalizeEvidence(criteria, '完成交付', [row, row])[0].status, 'missing');
});
test('model failure in production never returns prerecorded candidate, JD or screening', async t => {
  const old = process.env.NODE_ENV, demo = process.env.SHANGSHU_RECRUITMENT_DEMO;
  process.env.NODE_ENV = 'production'; process.env.SHANGSHU_RECRUITMENT_DEMO = '1';
  t.mock.method(globalThis, 'fetch', async () => { throw Error('offline'); });
  try {
    await assert.rejects(aiParseResume('没有学历或经历的材料'), /RECRUITMENT_AI_UNAVAILABLE/);
    await assert.rejects(aiGenerateJD({ title: '岗位', department: '部门', headcount: 1, requirements: '', highlights: '' }), /RECRUITMENT_AI_UNAVAILABLE/);
    await assert.rejects(aiScreenApplication({ job: { title: '岗位', requirements: '' }, candidate: { name: '', email: '', phone: '', education: '', experience_years: 0, skills: [], summary: '' } }), /RECRUITMENT_AI_UNAVAILABLE/);
  } finally {
    if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old;
    if (demo === undefined) delete process.env.SHANGSHU_RECRUITMENT_DEMO; else process.env.SHANGSHU_RECRUITMENT_DEMO = demo;
  }
});
test('repeated human rejection is never a learned experience threshold', async () => {
  const episodes = [1, 2, 3].map(i => ({ id: String(i), kind: 'screening_decision', ai_recommend: 'advance', human_decision: 'reject', candidate: JSON.stringify({ experience_years: 3 }), created_at: '' }));
  const store: any = { query: async (_layer: string, table: string) => table === 'recruitment_episodes' ? episodes : [] };
  assert.deepEqual(await extractSkillDrafts(store), []);
});
test('legacy unscoped and foreign-job preferences cannot affect a job', async () => {
  const store: any = { query: async () => [
    { status: 'active', rule_type: 'jd_style', pattern: JSON.stringify({ remove_section: '加分项' }) },
    { status: 'active', job_id: 'other', rule_type: 'jd_style', pattern: JSON.stringify({ remove_section: '职责' }) },
  ] };
  assert.deepEqual(await activePreferenceLines(store, 'job'), { screening: [], jd: [] });
  assert.deepEqual(await activePreferenceLines(store), { screening: [], jd: [] });
});
test('same length JD edits invalidate the confirmation snapshot', async () => {
  registerRecruitmentContracts();
  let content = '负责开发';
  const store: any = { query: async () => [{ id: 'J', status: 'draft', jd_draft: content }] };
  const action = getActionContract('recruitment.jd.publish')!;
  const before = await action.snapshot!(store, { job_id: 'J' });
  content = '负责测试';
  assert.notDeepEqual(await action.snapshot!(store, { job_id: 'J' }), before);
});
