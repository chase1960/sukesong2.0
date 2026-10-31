# Recruitment Domain Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付招聘域第一阶段可运行的 Frappe 后端：岗位、不可变 JD/筛选标准版本、受管 Action、权限与 AI 提案治理。

**Architecture:** 新建独立 `shangshu_recruitment` App，业务事实只写本域 DocType；所有写操作经 `shangshu_core.public_api` 注册并执行。`job.py` 与 `revisions.py` 分别拥有岗位和版本化文档规则，`domain.py` 只聚合贡献，`install.py` 只注册版本化定义；AI 只能形成 `recruitment.jd.save` 提案，人工确认后执行，发布仍是独立动作。

**Tech Stack:** Python 3.12、Frappe 15、MariaDB、`shangshu_core.public_api`、FrappeTestCase、仓库 Node 静态门禁。

## Global Constraints

- 只实现设计文档阶段 A；邮件 intake、简历/OCR、申请流程、面试、Offer、入职分别进入后续计划，本计划不以 mock 冒充这些能力。
- 业务代码只 import `shangshu_core.public_api`；不得导入 core 私有模块或其他业务 App。
- 所有业务写操作必须经注册 Action、人工确认、幂等、乐观锁、域写标记和统一审计。
- 已发布 JD/rubric 不可覆盖；修改必须新建 revision；岗位开放前必须同时存在已发布 JD 和 rubric。
- AI 只可提案 `recruitment.jd.save`，不得直接调用 `recruitment.jd.publish` 或 `recruitment.job.open`。
- 资源前缀固定为 `recruitment.*`，manifest ID 固定为 `com.shangshu.recruitment`，Action 初始版本固定为 `1.0.0`。
- 不修改 core、公共 BFF、前端壳、部署、其他业务域，也不复制 `shangshu_flow`。
- 不混入已有无关工作区变更：`D shangshu-server/node_modules`、`?? AGENTS.md`、`?? CLAUDE.md`。
- 每个任务保留正常链、拒绝链、越权链、幂等/重放测试；0 用例不得视为通过。
- 当前快照无 `bench` 且缺少 `.frappe-deploy/runtime.json` 时，Frappe 站点测试标记 NOT_RUN，不得伪报通过；静态检查与站点测试分开报告。

---

### Task 1: 招聘 App 骨架、公共 schema 与边界策略

**Files:**
- Create: `frappe_apps/shangshu_recruitment/shangshu-plugin.yml`
- Create: `frappe_apps/shangshu_recruitment/pyproject.toml`
- Create: `frappe_apps/shangshu_recruitment/MANIFEST.in`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/__init__.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/hooks.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/modules.txt`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/patches.txt`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/common.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/tests/__init__.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/tests/test_manifest.py`
- Create: `scripts/domain-policies/recruitment.json`

**Interfaces:**
- Produces: `DOMAIN = 'com.shangshu.recruitment'`。
- Produces: `ROLES = ['Recruitment Admin', 'Recruiter', 'Hiring Manager']`。
- Produces: `schema(properties: dict, required: list[str]) -> dict`，且 `additionalProperties=False`。
- Produces: `text(title: str, maximum: int = 140) -> dict`。
- Produces: `reference(name_label: str) -> dict`，返回 `{'name': ..., 'revision': ...}`，revision 最小值为 1。
- Produces: hooks 贡献入口 `shangshu_recruitment.domain.get_contribution`；安装/迁移入口 `shangshu_recruitment.install.setup`。

- [ ] **Step 1: 写失败的 manifest/边界测试**

```python
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[2]

def test_manifest_and_policy_declare_recruitment_namespace():
    manifest = yaml.safe_load((ROOT / 'shangshu-plugin.yml').read_text())
    assert manifest['id'] == 'com.shangshu.recruitment'
    assert manifest['dependencies'] == ['com.shangshu.core@">=0.1"']
    assert all(item.startswith('recruitment.') for item in manifest['exports']['actions'])
    policy = json.loads(Path('scripts/domain-policies/recruitment.json').read_text())
    assert policy['domain'] == manifest['id']
    assert 'frappe_apps/shangshu_recruitment/' in policy['paths']['allowed']
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `python3 -m pytest frappe_apps/shangshu_recruitment/shangshu_recruitment/tests/test_manifest.py -q`
Expected: FAIL，原因是 manifest 和策略文件尚不存在；若环境无 pytest，则记录 NOT_RUN，并继续用 JSON/YAML 解析门禁验证，不安装新依赖。

- [ ] **Step 3: 创建最小骨架与公共接口**

`common.py` 完整实现：

```python
DOMAIN = 'com.shangshu.recruitment'
ROLES = ['Recruitment Admin', 'Recruiter', 'Hiring Manager']


def text(title, maximum=140):
    return {'type': 'string', 'title': title, 'minLength': 1, 'maxLength': maximum}


def schema(properties, required):
    return {'type': 'object', 'properties': properties, 'required': required,
            'additionalProperties': False}


def reference(name_label):
    return {'name': text(name_label), 'revision': {
        'type': 'integer', 'title': '修订', 'minimum': 1}}
```

`shangshu-plugin.yml` 声明 `id: com.shangshu.recruitment`、`platform_api: ">=1.0 <2.0"`、`uninstall: retain_data`，exports 只列本计划七个 Action 与三个对象：

```yaml
id: com.shangshu.recruitment
name: 尚书招聘
version: 0.1.0
platform_api: ">=1.0 <2.0"
dependencies:
  - com.shangshu.core@">=0.1"
exports:
  applications: [com.shangshu.recruitment.management]
  objects: [recruitment.job, recruitment.jd_revision, recruitment.screening_rubric]
  datasets: [recruitment.job]
  actions:
    - recruitment.job.save
    - recruitment.job.open
    - recruitment.job.close
    - recruitment.jd.save
    - recruitment.jd.publish
    - recruitment.rubric.save
    - recruitment.rubric.publish
  tools: [recruitment.jd.save]
  workflows: []
  roles: []
  navigation: []
  workbench: []
  pages: []
  services: []
  events: []
  subscriptions: []
migrations: []
uninstall: retain_data
```

`hooks.py` 使用 `required_apps = ['frappe', 'shangshu_core']`，注册贡献、`after_install`/`after_migrate`，并为三个本域 DocType 配置 `permission_query_conditions` 和 `has_permission`。策略文件 allowed 仅包含招聘 App、`docs/domains/recruitment/` 和 `scripts/domain-policies/`；core、公共 BFF、web、ops、scripts 为 review_required，其他业务 App 为 forbidden。

- [ ] **Step 4: 运行静态验证**

Run: `python3 -m compileall -q frappe_apps/shangshu_recruitment && SHANGSHU_DOMAIN_POLICY=recruitment npm run check:domain`
Expected: Python 编译成功；边界检查不包含任何 forbidden 改动。若因缺少公共 baseline ref 返回环境错误，保留原始输出并标注环境阻塞。

- [ ] **Step 5: 提交骨架**

```bash
git add frappe_apps/shangshu_recruitment scripts/domain-policies/recruitment.json
git commit -m "feat: scaffold recruitment domain"
```

### Task 2: 岗位 DocType、受管保存/开放/关闭与记录权限

**Files:**
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/job.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/service.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/shangshu_recruitment/doctype/shangshu_recruitment_job/shangshu_recruitment_job.json`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/shangshu_recruitment/doctype/shangshu_recruitment_job/shangshu_recruitment_job.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/tests/test_job.py`

**Interfaces:**
- Consumes: Task 1 的 `DOMAIN`、`ROLES`、`text`、`schema`、`reference`。
- Produces: `JOB_FIELDS: dict[str, dict]`，字段为 `job_code/title/department/hiring_manager/headcount/requirements/location/employment_type`。
- Produces: `JOB_ACTIONS = [('recruitment.job.save', ...), ('recruitment.job.open', ...), ('recruitment.job.close', ...)]`。
- Produces: `execute_job(action_id: str, payload: dict) -> dict`，回执固定含 `job/status/revision/current_jd_revision/current_rubric_revision`。
- Produces: `permission_query(user=None) -> str` 与 `permission(doc, user=None, permission_type=None) -> bool`；System Manager 不绕过企业隔离。
- Consumes later: Task 3 的 `published_revision_exists(doctype: str, job: str) -> bool`，`job.open` 必须同时验证 JD 和 rubric。

- [ ] **Step 1: 写失败的岗位行为测试**

```python
def test_job_requires_confirmation_and_open_requires_published_revisions(self):
    job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
    self.assertEqual(job['status'], 'draft')
    with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_JD_OR_RUBRIC_NOT_PUBLISHED'):
        self.action('recruiter', 'recruitment.job.open', {
            'job': job['job'], 'revision': job['revision']})
    with self.assertRaises(frappe.PermissionError):
        frappe.set_user(self.users['recruiter'])
        execute_registered_action('recruitment.job.close', {
            'job': job['job'], 'revision': job['revision']},
            confirmed=False, idempotency_key=frappe.generate_hash())


def test_job_replay_revision_conflict_and_cross_enterprise_denial(self):
    key = frappe.generate_hash()
    created = self.action('recruiter', 'recruitment.job.save', self.job_payload(), key)
    self.assertEqual(self.action('recruiter', 'recruitment.job.save', self.job_payload(), key), created)
    with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_REVISION_CONFLICT'):
        self.action('recruiter', 'recruitment.job.close', {'job': created['job'], 'revision': 0})
```

测试 setUp 必须创建真实 `Recruiter`、无角色用户和另一 enterprise 的可见性夹具，不用 Administrator 代替越权断言。

- [ ] **Step 2: 运行站点测试并确认失败**

Run: `bench --site <test-site> run-tests --app shangshu_recruitment --module shangshu_recruitment.tests.test_job`
Expected: FAIL，Action/DocType 尚未注册。当前无 bench 时记录 NOT_RUN，不以静态编译替代行为测试。

- [ ] **Step 3: 实现 DocType 写闸与岗位 Action**

DocType 字段包含 `enterprise_id`、Task 2 的八个业务字段、`status(draft/open/closed)`、`current_jd_revision`、`current_rubric_revision`、`revision`；`job_code` 与 `enterprise_id` 建唯一约束，status/revision 不暴露给 payload。控制器：

```python
class ShangshuRecruitmentJob(Document):
    def validate(self):
        if not getattr(frappe.flags, 'recruitment_write', False):
            frappe.throw('RECRUITMENT_PERMISSION_DENIED: 岗位只允许受管动作修改', frappe.PermissionError)

    def on_trash(self):
        frappe.throw('RECRUITMENT_PERMISSION_DENIED: 招聘记录不可删除', frappe.PermissionError)
```

`service.execute` 对 Job/JD/rubric 共用入口，先 `require_roles`，再强制 `context['confirmed']`，开启并恢复 `frappe.flags.recruitment_write`，按 action 分发。岗位保存规则：

```python
if action_id == 'recruitment.job.save' and not payload.get('job'):
    values = {key: payload.get(key) for key in JOB_FIELDS}
    doc = frappe.get_doc({'doctype': 'Shangshu Recruitment Job', **values,
        'enterprise_id': ctx['enterprise_id'], 'status': 'draft', 'revision': 1})
    doc.insert(ignore_permissions=True)
else:
    doc = locked_job(payload['job'], ctx['enterprise_id'])
    require_revision(doc, payload['revision'])
    if action_id == 'recruitment.job.save':
        require_status(doc, 'draft')
        doc.update({key: payload[key] for key in JOB_FIELDS if key in payload})
    elif action_id == 'recruitment.job.open':
        require_status(doc, 'draft', 'closed')
        require_published_revisions(doc.name)
        doc.status = 'open'
        doc.current_jd_revision = latest_published('Shangshu Recruitment JD Revision', doc.name)
        doc.current_rubric_revision = latest_published('Shangshu Recruitment Screening Rubric', doc.name)
    elif action_id == 'recruitment.job.close':
        require_status(doc, 'open')
        doc.status = 'closed'
    doc.revision += 1
    doc.save(ignore_permissions=True)
```

`require_revision` 抛出稳定码 `RECRUITMENT_REVISION_CONFLICT`；无发布版本抛 `RECRUITMENT_JD_OR_RUBRIC_NOT_PUBLISHED`；关闭后重新开放必须再次校验当前发布版本。权限只允许同 enterprise 的 System Manager/Recruitment Admin/Recruiter，以及所负责岗位的 Hiring Manager 读取；写权限只给 System Manager/Recruitment Admin/Recruiter。

- [ ] **Step 4: 运行测试与静态检查**

Run: `python3 -m compileall -q frappe_apps/shangshu_recruitment && npm run check:platform-contract`
Expected: 编译和 manifest/import 检查通过；站点行为测试在可用隔离站执行并通过。

- [ ] **Step 5: 提交岗位实现**

```bash
git add frappe_apps/shangshu_recruitment
git commit -m "feat: add managed recruitment job actions"
```

### Task 3: 不可变 JD/rubric revision 与 AI 提案链

**Files:**
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/revisions.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/shangshu_recruitment/doctype/shangshu_recruitment_jd_revision/shangshu_recruitment_jd_revision.json`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/shangshu_recruitment/doctype/shangshu_recruitment_jd_revision/shangshu_recruitment_jd_revision.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/shangshu_recruitment/doctype/shangshu_recruitment_screening_rubric/shangshu_recruitment_screening_rubric.json`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/shangshu_recruitment/doctype/shangshu_recruitment_screening_rubric/shangshu_recruitment_screening_rubric.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/tests/test_revisions.py`

**Interfaces:**
- Consumes: Task 1 的 schema helpers；Task 2 的 `locked_job`、`require_revision`、统一 `service.execute` 分发。
- Produces: `REVISION_ACTIONS` 含 `recruitment.jd.save/publish` 与 `recruitment.rubric.save/publish`。
- Produces: `execute_revision(action_id: str, payload: dict) -> dict`，回执含 `revision_document/job/version_no/status/document_revision`。
- Produces: `published_revision_exists(doctype: str, job: str) -> bool`。
- Produces: `latest_published(doctype: str, job: str) -> str`，返回记录 name；无记录时返回空字符串。
- Produces: `require_published_revisions(job: str) -> None`，供 `job.open` 使用。

- [ ] **Step 1: 写失败的版本与 AI 治理测试**

```python
def test_published_revision_is_immutable_and_job_opens_after_both_publish(self):
    job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
    jd = self.action('recruiter', 'recruitment.jd.save', self.jd_payload(job['job']))
    rubric = self.action('recruiter', 'recruitment.rubric.save', self.rubric_payload(job['job']))
    self.action('recruiter', 'recruitment.jd.publish', {'revision_document': jd['revision_document'],
        'revision': jd['document_revision']})
    self.action('recruiter', 'recruitment.rubric.publish', {'revision_document': rubric['revision_document'],
        'revision': rubric['document_revision']})
    opened = self.action('recruiter', 'recruitment.job.open', {'job': job['job'], 'revision': 1})
    self.assertEqual(opened['status'], 'open')
    with self.assertRaisesRegex(frappe.ValidationError, 'RECRUITMENT_REVISION_IMMUTABLE'):
        self.action('recruiter', 'recruitment.jd.save', {'revision_document': jd['revision_document'],
            'revision': 2, 'job': job['job'], 'content': '覆盖已发布版本', 'source': 'manual'})


def test_ai_can_only_propose_jd_draft_not_publish_or_open(self):
    job = self.action('recruiter', 'recruitment.job.save', self.job_payload())
    proposal = propose_registered_action('recruitment.jd.save', self.jd_payload(job['job']))
    self.assertEqual(frappe.db.count('Shangshu Recruitment JD Revision', {'job': job['job']}), 0)
    for forbidden in ('recruitment.jd.publish', 'recruitment.job.open'):
        with self.assertRaises(frappe.PermissionError):
            propose_registered_action(forbidden, {})
```

另加 rubric 禁用条件测试：出现 `gender/sex/ethnicity/race/religion/marital_status/pregnancy/photo/name/email/phone`（大小写不敏感）时抛 `RECRUITMENT_DISALLOWED_CRITERION`。

- [ ] **Step 2: 运行测试并确认失败**

Run: `bench --site <test-site> run-tests --app shangshu_recruitment --module shangshu_recruitment.tests.test_revisions`
Expected: FAIL，revision Action 尚未实现；无站点时标记 NOT_RUN。

- [ ] **Step 3: 实现版本化文档和动作**

JD 字段：`enterprise_id/job/version_no/content/source(manual/ai_assisted)/status(draft/published/retired)/model_name/model_version/published_by/published_at/revision`；rubric 字段：`enterprise_id/job/version_no/required_criteria/preferred_criteria/weights/disallowed_criteria/status/published_by/published_at/revision`。JSON 文本字段在 Action 边界校验为对象/数组并规范化，禁止直接信任模型字符串。两个控制器都用 Task 2 同样的 `recruitment_write` 写闸和禁止删除。

保存新 revision 时，使用 `frappe.db.count(..., {'job': job}) + 1` 并在 `(enterprise_id, job, version_no)` 上建立唯一约束；数据库冲突必须回滚，不覆盖旧版本。已存在记录仅 draft 可编辑，published 抛 `RECRUITMENT_REVISION_IMMUTABLE`。发布时锁定记录、校验 revision 与 draft 状态，然后设置：

```python
doc.status = 'published'
doc.published_by = ctx['user_name']
doc.published_at = frappe.utils.now_datetime()
doc.revision += 1
doc.save(ignore_permissions=True)
```

rubric 保存前扫描 `required_criteria`、`preferred_criteria`、`weights` 的键和文本值，命中禁用词即拒绝；`weights` 必须是对象，键必须出现在 required/preferred criteria 中，值必须是有限非负数且总和大于 0。`service.execute` 对 `REVISION_ACTIONS` 分发到 `execute_revision`，Action 注册时只有 `recruitment.jd.save` 进入 tools，所有写 Action `effect='write'`、`confirmation='required'`。

- [ ] **Step 4: 运行测试与版本注册检查**

Run: `python3 -m compileall -q frappe_apps/shangshu_recruitment && npm run check:platform-contract && npm run test:platform-contract`
Expected: 全部静态门禁通过；隔离站测试验证发布后不可变、AI 未落库、人工确认后落库。

- [ ] **Step 5: 提交 revision 实现**

```bash
git add frappe_apps/shangshu_recruitment
git commit -m "feat: add immutable recruitment JD and rubric revisions"
```

### Task 4: 聚合贡献、安装注册、域文档与整体验证

**Files:**
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/domain.py`
- Create: `frappe_apps/shangshu_recruitment/shangshu_recruitment/install.py`
- Create: `docs/domains/recruitment/AGENTS.md`
- Modify: `frappe_apps/shangshu_recruitment/shangshu_recruitment/service.py`
- Test: `frappe_apps/shangshu_recruitment/shangshu_recruitment/tests/test_manifest.py`

**Interfaces:**
- Consumes: `JOB_ACTIONS`、`REVISION_ACTIONS`、`execute_job`、`execute_revision` 和三个对象字段定义。
- Produces: `get_contribution() -> dict` 与 `setup() -> None`。
- Produces: `execute(action_id: str, payload: dict, context: dict) -> dict` 统一入口。

- [ ] **Step 1: 写贡献一致性失败测试**

```python
def test_manifest_exports_match_domain_contribution():
    from shangshu_recruitment.domain import get_contribution
    manifest = yaml.safe_load((ROOT / 'shangshu-plugin.yml').read_text())
    contribution = get_contribution()
    assert set(manifest['exports']['actions']) == {item['id'] for item in contribution['actions']}
    assert set(manifest['exports']['objects']) == {item['id'] for item in contribution['objects']}
    assert manifest['exports']['tools'] == ['recruitment.jd.save']
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `python3 -m pytest frappe_apps/shangshu_recruitment/shangshu_recruitment/tests/test_manifest.py -q`
Expected: FAIL，`domain.py`/`install.py` 尚不存在；无 pytest 时 NOT_RUN。

- [ ] **Step 3: 实现聚合、注册和文档**

`domain.py` 聚合 `JOB_ACTIONS + REVISION_ACTIONS`，每个动作 handler 都是 `shangshu_recruitment.service.execute`；注册 Job dataset/object 以及 JD/rubric 只读对象，record action bindings 显式绑定 name/revision。`install.py`：

```python
from shangshu_core.public_api import ensure_registered_domains, register_action
from shangshu_recruitment.domain import ACTIONS


def setup():
    ensure_registered_domains()
    for role in ROLES:
        if not frappe.db.exists('Role', role):
            frappe.get_doc({'doctype': 'Role', 'role_name': role}).insert(ignore_permissions=True)
    for action, title, roles, input_schema in ACTIONS:
        register_action(action, '1.0.0', title, 'write', 'required', roles,
                        input_schema, {})
```

`docs/domains/recruitment/AGENTS.md` 记录：事实权威、七个 Action、角色、revision/不可变规则、AI 只提案、后续 B–E 尚未实现、真实站点测试命令和当前环境限制。不得宣称邮箱/OCR/完整招聘 pipeline 已交付。

- [ ] **Step 4: 执行完整门禁并分开记录结果**

```bash
python3 -m compileall -q frappe_apps/shangshu_recruitment
SHANGSHU_DOMAIN_POLICY=recruitment npm run check:domain
npm run check:platform-contract
npm run test:platform-contract
npm run test:domain-boundary
npm run check:style
npm run check:logs
npm --prefix shangshu-server run typecheck
bench --site <test-site> migrate
bench --site <test-site> run-tests --app shangshu_recruitment
```

Expected: 新增静态门禁通过；站点测试非 0 用例且通过。`llm.ts`/`pi-chat.ts` 的既有 typecheck 错误单独标注；bench 不存在时站点测试 NOT_RUN。不得把 NOT_RUN 写成 PASS。

- [ ] **Step 5: 提交第一阶段完整切片**

```bash
git add frappe_apps/shangshu_recruitment docs/domains/recruitment scripts/domain-policies/recruitment.json docs/superpowers/plans/2026-10-31-recruitment-domain-foundation.md
git commit -m "feat: deliver recruitment domain foundation"
```
