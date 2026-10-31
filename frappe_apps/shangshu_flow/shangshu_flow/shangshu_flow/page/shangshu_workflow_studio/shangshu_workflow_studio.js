frappe.pages["shangshu-workflow-studio"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "流程设计器",
		single_column: true,
	});
	// 设计器自带头部承载全部信息，Desk 的 page-head 会与它重叠。
	$(wrapper).find(".page-head").hide();
	wrapper.shangshu_workflow_studio = new ShangshuWorkflowStudio(wrapper, page);
};

frappe.pages["shangshu-workflow-studio"].on_page_show = function (wrapper) {
	wrapper.shangshu_workflow_studio?.load();
};

frappe.pages["shangshu-workflow-studio"].on_page_hide = function (wrapper) {
	wrapper.shangshu_workflow_studio?.pause();
};

const NOOP = () => {};

class ShangshuWorkflowStudio {
	constructor(wrapper, page) {
		this.wrapper = wrapper;
		this.page = page;
		this.workflow = "费用报销审批";
		this.active = "flow";
		// Frappe WorkflowBuilder 会在构造时改写 page 标题与动作；
		// 传入 mock page 让它只负责画布本身，外壳由设计器统一管理。
		this.builderPage = {
			set_title: NOOP,
			set_indicator: NOOP,
			clear_actions: NOOP,
			clear_menu: NOOP,
			clear_custom_actions: NOOP,
			set_primary_action: NOOP,
			add_button: NOOP,
			add_menu_item: NOOP,
		};
		this.$host = $(wrapper).find(".layout-main-section");
		this.shell = ShangshuPlatform.mount(this.$host, {
			active: "studio",
			compact: true,
			title: "流程设计",
			subtitle: "把业务路径、表单、数据和权限一起发布成可办理的应用。",
		});
		this.$root = this.shell.$content.addClass("ss-studio-shell");
	}

	async load() {
		if (this.loading) return;
		this.loading = true;
		try {
			this.context = await frappe.xcall("shangshu_flow.api.get_studio_context", {workflow_name: this.workflow});
			if (!this.shellReady) {
				this.renderShell();
			}
			await this.showView(this.active);
		} catch (error) {
			this.$root.html('<div class="ss-empty">设计器数据读取失败：' + frappe.utils.escape_html(String(error.message || error)) + "</div>");
			throw error;
		} finally {
			this.loading = false;
		}
	}

	renderShell() {
		const views = [
			["flow", "流程图", "workflow"],
			["form", "表单页面", "file"],
			["mapping", "数据流转", "change"],
			["access", "办理权限", "users"],
			["publish", "发布测试", "upload"],
		];
		this.$root.html(`
			<div class="ss-studio-top">
				<div class="ss-studio-id">
					<span class="ss-live-dot ${this.context.workflow.is_active ? "" : "is-off"}"></span>
					<strong>${frappe.utils.escape_html(this.context.workflow.name)}</strong>
					<em>${this.context.workflow.is_active ? "已发布" : "未发布"}</em>
				</div>
				<nav aria-label="设计视图">${views.map(([key, label, icon]) => `<button data-view="${key}" class="${this.active === key ? "is-active" : ""}" title="${label}">${frappe.utils.icon(icon, "sm")}<span>${label}</span></button>`).join("")}</nav>
				<div class="ss-studio-actions">
					<button class="ss-secondary ss-canvas-btn" data-canvas="reset" hidden>重置</button>
					<button class="ss-primary ss-canvas-btn" data-canvas="save" hidden>保存流程</button>
					<button class="ss-secondary ss-test-flow">去流程中心</button>
				</div>
			</div>
			<div class="ss-studio-stage"></div>
			<button class="ss-ai-fab" title="AI 辅助设计（仅生成提案，不直接发布）">${frappe.utils.icon("star", "md")}<span>AI 设计</span></button>
		`);
		this.$root.find("[data-view]").on("click", (event) => this.showView(event.currentTarget.dataset.view));
		this.$root.find(".ss-canvas-btn").on("click", (event) => this.canvasAction(event.currentTarget.dataset.canvas));
		this.$root.find(".ss-test-flow").on("click", () => frappe.set_route("shangshu-process-center"));
		this.$root.find(".ss-ai-fab").on("click", () => this.openAiDesigner());
		this.applyShellHeight();
		if (!this._resizeBound) {
			this._resizeBound = true;
			$(window).on("resize.ss-studio", () => this.applyShellHeight());
		}
		this.shellReady = true;
	}

	applyShellHeight() {
		const navbar = document.querySelector(".navbar");
		const chrome = navbar && navbar.offsetHeight > 0 ? navbar.offsetHeight : 0;
		const platformTop = this.$host.find(".ss-platform-topbar").outerHeight() || 58;
		this.$root.css("height", Math.max(320, window.innerHeight - chrome - platformTop));
		const topHeight = this.$root.find(".ss-studio-top").outerHeight() || 58;
		this.$root.find(".ss-studio-stage").css("height", Math.max(320, window.innerHeight - chrome - platformTop - topHeight));
	}

	async showView(view) {
		this.active = view;
		this.$root.find("[data-view]").removeClass("is-active");
		this.$root.find(`[data-view="${view}"]`).addClass("is-active");
		this.$root.find(".ss-canvas-btn").attr("hidden", view !== "flow" ? "" : null);
		this.destroyCanvas();
		const $stage = this.$root.find(".ss-studio-stage").empty();
		if (view === "flow") {
			$stage.html(`<div class="ss-flow-context"><strong>费用报销审批</strong><span>${frappe.utils.escape_html(this.context.workflow.journey)}</span></div><div class="ss-flow-canvas"></div>`);
			await frappe.require("workflow_builder.bundle.js");
			this.builder = new frappe.ui.WorkflowBuilder({
				wrapper: $stage.find(".ss-flow-canvas"),
				page: this.builderPage,
				workflow: this.workflow,
			});
			this.fitCanvasWhenReady();
			this.startBreadcrumbGuard();
			return;
		}
		this.renderMetadataView(view, $stage);
	}

	fitCanvasWhenReady() {
		// Builder 的 fitView 在节点加载完成前触发会空转，这里等节点齐了再点 Fit。
		const expected = this.context.workflow.state_count + this.context.workflow.transition_count;
		let tries = 0;
		clearInterval(this._fitTimer);
		this._fitTimer = setInterval(() => {
			tries += 1;
			const nodes = document.querySelectorAll(".ss-flow-canvas .vue-flow__node").length;
			if (nodes >= expected) {
				clearInterval(this._fitTimer);
				this._fitTimer = null;
				const fit = [...document.querySelectorAll(".ss-flow-canvas button")].find((b) => ["Fit", "适应画布"].includes(b.textContent.trim()));
				fit?.click();
			} else if (tries > 20) {
				clearInterval(this._fitTimer);
				this._fitTimer = null;
			}
		}, 250);
	}

	destroyCanvas() {
		clearInterval(this._fitTimer);
		this._fitTimer = null;
		if (this.builder) {
			try {
				this.builder.$workflow_builder?.unmount();
			} catch (error) {
				// 画布已脱离 DOM 时忽略卸载异常
			}
			this.builder = null;
		}
	}

	pause() {
		this.destroyCanvas();
		this._bcObserver?.disconnect();
		this._bcObserver = null;
	}

	canvasAction(kind) {
		if (!this.builder?.store) return;
		if (kind === "save") {
			this.builder.store.save_changes().then(() => {
				frappe.show_alert({message: "流程已保存", indicator: "green"});
				this.fixBreadcrumbs();
				this.refreshContext();
			});
		} else {
			this.builder.store.reset_changes();
			frappe.show_alert({message: "已恢复为已保存版本", indicator: "blue"});
		}
	}

	async refreshContext() {
		this.context = await frappe.xcall("shangshu_flow.api.get_studio_context", {workflow_name: this.workflow});
		this.updateStatusPill();
	}

	updateStatusPill() {
		const info = this.context.workflow;
		this.$root.find(".ss-studio-id em").text(info.is_active ? "已发布" : "未发布");
		this.$root.find(".ss-live-dot").toggleClass("is-off", !info.is_active);
	}

	startBreadcrumbGuard() {
		this.fixBreadcrumbs();
		const bc = document.getElementById("navbar-breadcrumbs");
		if (!bc || this._bcObserver) return;
		this._bcObserver = new MutationObserver(() => {
			// Builder 会把面包屑改写成指向 /app/workflow 的链接（中英文都可能），一律还原为设计器上下文。
			if (bc.querySelector('a[href="/app/workflow"], a[href*="/app/workflow/"]')) this.fixBreadcrumbs();
		});
		this._bcObserver.observe(bc, {childList: true});
	}

	fixBreadcrumbs() {
		const bc = document.getElementById("navbar-breadcrumbs");
		if (!bc) return;
		bc.innerHTML = '<li class="breadcrumb-item"><a href="/app/shangshu-workflow-studio">流程设计器</a></li><li class="breadcrumb-item"><span>费用报销审批</span></li>';
	}

	renderMetadataView(view, $stage) {
		const esc = frappe.utils.escape_html;
		const statusLabel = {pass: "通过", warn: "注意", fail: "不通过"};
		if (view === "form") {
			$stage.html(`<div class="ss-meta-view"><header><div><h3>发起表单</h3><p>字段来自「报销申请」对象元数据，发布后即流程中心的办理界面。</p></div><div class="ss-header-btns"><button class="ss-secondary" data-act="preview">预览发起表单</button><button class="ss-secondary" data-act="doctype">编辑字段</button></div></header><div class="ss-field-list"><div class="ss-list-head-row"><span></span><span>字段</span><span>类型</span><span>列表可见</span><span>约束</span></div>${this.context.form_fields.map((field) => `<div><span class="ss-drag">${frappe.utils.icon("drag", "sm")}</span><strong>${esc(field.label)}</strong><small>${esc(field.fieldname)} · ${esc(field.fieldtype)}</small><span>${field.in_list_view ? "显示" : "—"}</span><span class="ss-field-flags">${field.required ? '<i class="ss-flag req">必填</i>' : ""}${field.read_only ? '<i class="ss-flag ro">只读</i>' : ""}</span></div>`).join("")}</div></div>`);
			$stage.find('[data-act="preview"]').on("click", () => window.open("/app/expense-request/new", "_blank"));
			$stage.find('[data-act="doctype"]').on("click", () => frappe.set_route("Form", "DocType", this.context.workflow.document_type));
			return;
		}
		if (view === "mapping") {
			const dirLabel = {write: "写入", read: "读取", write_after_confirm: "确认后写入"};
			$stage.html(`<div class="ss-meta-view"><header><div><h3>数据与字段映射</h3><p>发起表单与流程引擎写入对象字段；AI 写入需确认，不允许直接改写历史。</p></div></header><div class="ss-mapping-list">${this.context.mapping.map((row) => `<div><code>${esc(row.source)}</code><span>${frappe.utils.icon("arrow-right", "sm")}</span><code>${esc(row.target)}</code><i class="${row.direction === "write_after_confirm" ? "is-confirm" : ""}">${dirLabel[row.direction] || row.direction}</i></div>`).join("")}</div></div>`);
			return;
		}
		if (view === "access") {
			$stage.html(`<div class="ss-meta-view ss-access-view"><header><div><h3>权限与参与人</h3><p>节点参与人来自流程转换角色；能否审批在运行端由状态与角色共同校验。</p></div></header><div class="ss-access-list">${this.context.participants.map((row) => `<div class="ss-access-row"><div class="ss-access-state"><strong>${esc(this.stateLabel(row.stage))}</strong><small>参与角色：${esc(__(row.role))} · 单据状态 ${({0: "草稿", 1: "已提交", 2: "已取消"})[Number(row.doc_status)] ?? esc(row.doc_status)}</small></div><div class="ss-access-actions">${row.actions.length ? row.actions.map((action) => `<span><b>${esc(action.label)}</b><small>${esc(__(action.role))} → ${esc(this.stateLabel(action.to))}</small>${action.self_approval ? '<i class="ss-flag warn">允许自批</i>' : ""}</span>`).join("") : '<span class="ss-muted">终态，无待办动作</span>'}</div></div>`).join("")}</div></div>`);
			return;
		}
		const info = this.context.workflow;
		const modifiedBy = frappe.user_info(info.modified_by)?.fullname || info.modified_by;
		$stage.html(`<div class="ss-meta-view ss-publish-view"><header><div><h3>发布与测试</h3><p>发布前先确认以下检查；版本冻结尚未实现，修改会即时影响新实例。</p></div><div class="ss-header-btns"><button class="ss-secondary" data-act="test">发起测试实例</button><button class="ss-primary ${info.is_active ? "ss-danger" : ""}" data-act="publish">${info.is_active ? "停用流程" : "发布流程"}</button></div></header><div class="ss-release-card"><span>${frappe.utils.icon(info.is_active ? "solid-success" : "solid-warning", "lg")}</span><div><strong>${info.is_active ? "流程已发布，业务端可发起" : "流程未发布，业务端不可发起"}</strong><small>${info.state_count} 个状态 · ${info.transition_count} 条转换 · ${esc(modifiedBy)} 更新于 ${frappe.datetime.prettyDate(info.modified)}</small></div><div class="ss-release-stats">${Object.entries(this.context.instances_by_state).map(([state, count]) => `<span>${esc(this.stateLabel(state))}<b>${count}</b></span>`).join("")}</div></div><div class="ss-check-grid">${this.context.checks.map((check) => `<div class="is-${check.status}"><header><strong>${esc(check.title)}</strong><em>${statusLabel[check.status] || check.status}</em></header><small>${esc(check.detail)}</small></div>`).join("")}</div></div>`);
		$stage.find('[data-act="publish"]').on("click", () => this.togglePublish());
		$stage.find('[data-act="test"]').on("click", () => this.createTestInstance());
	}

	stateLabel(state) {
		// 内部值 → 中文显示名：优先自有映射，其余走翻译字典（仅显示，不回写数据）。
		return ({
			Draft: "草稿",
			"Pending Manager Approval": "待经理审批",
			"Pending Finance Review": "待财务审批",
			Approved: "已通过",
			Rejected: "已退回",
		})[state] || __(state);
	}

	togglePublish() {
		const active = this.context.workflow.is_active;
		frappe.confirm(
			active
				? "停用后业务端将无法发起新实例，确定停用？"
				: "发布后流程对全体员工生效，确定发布？",
			async () => {
				const result = await frappe.xcall("shangshu_flow.api.set_workflow_active", {
					workflow_name: this.workflow,
					active: active ? 0 : 1,
				});
				frappe.show_alert({message: result.message, indicator: result.is_active ? "green" : "orange"});
				await this.refreshContext();
				this.showView("publish");
			}
		);
	}

	async createTestInstance() {
		const result = await frappe.xcall("shangshu_flow.api.create_expense_request", {
			subject: `试运行实例 ${frappe.datetime.now_datetime()}`,
			amount: 100,
			purpose: "发布前试运行，验证路径与权限。",
			department: "流程测试",
		});
		frappe.show_alert({message: `测试实例 ${result.doc.name} 已创建，进入流程中心查看`, indicator: "green"});
		frappe.set_route("shangshu-process-center");
	}

	openAiDesigner() {
		let proposal = null;
		const dialog = new frappe.ui.Dialog({
			title: "AI 辅助设计工作流",
			fields: [
				{fieldname: "instruction", fieldtype: "Small Text", label: "告诉 AI 想怎么修改", reqd: 1, description: "AI 只生成结构化提案；写操作需确认，不会直接发布流程。"},
				{fieldname: "preview", fieldtype: "HTML"},
			],
			primary_action_label: "生成提案",
			primary_action: async ({instruction}) => {
				dialog.disable_primary_action();
				try {
					proposal = await frappe.xcall("shangshu_flow.api.propose_workflow_change", {workflow_name: this.workflow, instruction});
					dialog.fields_dict.preview.$wrapper.html(this.proposalTemplate(proposal));
					// 进入确认阶段后不再校验原始指令，避免确认按钮被必填拦截。
					dialog.fields_dict.instruction.df.reqd = 0;
					dialog.set_primary_action("确认并进入发布测试", async () => {
						const result = await frappe.xcall("shangshu_flow.api.apply_workflow_proposal", {proposal_id: proposal.proposal_id, confirmed: 1});
						dialog.hide();
						frappe.show_alert({message: result.message, indicator: "green"}, 8);
						this.showView("publish");
					});
				} finally {
					dialog.enable_primary_action();
				}
			},
		});
		dialog.show();
	}

	proposalTemplate(proposal) {
		const esc = frappe.utils.escape_html;
		return `<div class="ss-proposal"><span>${frappe.utils.icon("star", "sm")} AI 提案 <i>受控接口样例，未接入真实模型</i></span><p>${esc(proposal.summary)}</p>${proposal.changes.map((item) => `<div><code>${esc(item.operation)}</code><strong>${esc(item.state || item.action)}</strong><small>${esc(item.condition || item.role || "")}</small></div>`).join("")}<em>${esc(proposal.risk)}</em></div>`;
	}
}
