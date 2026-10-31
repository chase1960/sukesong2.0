frappe.pages["shangshu-process-center"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "流程中心",
		single_column: true,
	});
	// 流程中心使用自带的紧凑头部，隐藏 Desk 页头避免双标题。
	$(wrapper).find(".page-head").hide();
	wrapper.shangshu_process_center = new ShangshuProcessCenter(wrapper, page);
};

frappe.pages["shangshu-process-center"].on_page_show = function (wrapper) {
	wrapper.shangshu_process_center?.load();
};

const STATE_LABELS = {
	Draft: "草稿",
	"Pending Manager Approval": "待经理审批",
	"Pending Finance Review": "待财务审批",
	Approved: "已通过",
	Rejected: "已退回",
};

class ShangshuProcessCenter {
	constructor(wrapper, page) {
		this.wrapper = wrapper;
		this.page = page;
		this.active = "pending";
		this.$host = $(wrapper).find(".layout-main-section");
		this.shell = ShangshuPlatform.mount(this.$host, {
			active: "process",
			title: "流程中心",
			subtitle: "发起事项、处理待办，并在一个页面看清当前到了哪一步。",
		});
		this.$root = this.shell.$content.addClass("ss-process-shell");
	}

	async load() {
		this.$root.html('<div class="ss-loading">正在读取流程…</div>');
		try {
			this.data = await frappe.xcall("shangshu_flow.api.get_center");
			this.render();
		} catch (error) {
			this.$root.html('<div class="ss-empty">流程中心暂时无法读取</div>');
			throw error;
		}
	}

	render() {
		const requestedTab = sessionStorage.getItem("shangshu.process_tab");
		if (requestedTab) {
			this.active = requestedTab;
			sessionStorage.removeItem("shangshu.process_tab");
		}
		const tabs = [
			["launch", "可发起", "add"],
			["pending", "待我处理", "notification"],
			["started", "我发起的", "share-people"],
			["completed", "已完成", "check"],
			["copied", "抄送我的", "mail"],
		];
		this.$root.html(`
			<div class="ss-process-head"><div><strong>我的事项</strong><span>模板流程：填写报销单 → 经理审批 → 财务复核 → 完成</span></div><button class="ss-primary ss-new-expense">${frappe.utils.icon("add", "sm")}发起费用报销</button></div>
			<div class="ss-segmented" role="tablist">
				${tabs.map(([key, label, icon]) => `
					<button role="tab" data-tab="${key}" class="${this.active === key ? "is-active" : ""}">
						${frappe.utils.icon(icon, "sm")}<span>${label}</span>
						<em>${this.data.counts[key] || 0}</em>
					</button>`).join("")}
			</div>
			<div class="ss-process-content"></div>
			<div class="ss-instance-layer" aria-hidden="true"></div>
		`);
		this.bind();
		this.renderActive();
		if (sessionStorage.getItem("shangshu.launch_expense")) {
			sessionStorage.removeItem("shangshu.launch_expense");
			this.openLaunchDialog();
		}
		const instance = sessionStorage.getItem("shangshu.open_instance");
		if (instance) {
			sessionStorage.removeItem("shangshu.open_instance");
			this.openInstance(instance);
		}
	}

	bind() {
		this.$root.find("[data-tab]").on("click", (event) => {
			this.active = event.currentTarget.dataset.tab;
			this.$root.find("[data-tab]").removeClass("is-active");
			$(event.currentTarget).addClass("is-active");
			this.renderActive();
		});
		this.$root.find(".ss-new-expense").on("click", () => this.openLaunchDialog());
	}

	renderActive() {
		const $content = this.$root.find(".ss-process-content");
		if (this.active === "launch") {
			if (!this.data.launch.length) {
				$content.html(`<div class="ss-empty">${frappe.utils.icon("solid-warning", "lg")}<strong>当前没有可发起的流程</strong><span>流程发布后会自动出现在这里。</span></div>`);
				return;
			}
			$content.html(`
				<div class="ss-app-grid">
					<button class="ss-app-card">
						<span>${frappe.utils.icon("expenses", "lg")}</span>
						<strong>费用报销</strong>
						<small>填写报销单 → 经理审批 → 财务复核 → 完成</small>
					</button>
				</div>`);
			$content.find(".ss-app-card").on("click", () => this.openLaunchDialog());
			return;
		}

		const rows = this.data[this.active] || [];
		if (!rows.length) {
			$content.html(`<div class="ss-empty">${frappe.utils.icon("tick", "lg")}<strong>这里暂时没有流程</strong><span>新的事项会自动出现在对应视图。</span></div>`);
			return;
		}
		$content.html(`
			<div class="ss-process-list">
				<div class="ss-list-head"><span>事项</span><span>申请人</span><span>金额</span><span>状态</span><span></span></div>
				${rows.map((row) => this.rowTemplate(row)).join("")}
			</div>`);
		$content.find("[data-instance]").on("click", (event) => this.openInstance(event.currentTarget.dataset.instance));
	}

	rowTemplate(row) {
		const esc = frappe.utils.escape_html;
		return `<button class="ss-list-row" data-instance="${esc(row.name)}">
			<span><strong>${esc(row.subject)}</strong><small>${esc(row.name)} · ${frappe.datetime.str_to_user(row.expense_date)}</small></span>
			<span>${esc(row.applicant_name || this.userLabel(row.applicant))}</span>
			<span class="ss-money">${format_currency(row.amount, "CNY")}</span>
			<span><i class="ss-status is-${esc(this.stateClass(row.workflow_state))}">${esc(this.stateLabel(row.workflow_state))}</i></span>
			<span>${frappe.utils.icon("right", "sm")}</span>
		</button>`;
	}

	userLabel(user) {
		if (!user) return "—";
		const full = frappe.user_info(user)?.fullname;
		return full && full !== user ? `${full}` : user;
	}

	stateLabel(state) {
		// 内部值 → 中文显示名：优先自有映射，其余走翻译字典（仅显示，不回写数据）。
		if (!state) return "待处理";
		return STATE_LABELS[state] || __(state);
	}

	stateClass(state) {
		return String(state || "unknown").replace(/\s+/g, "-");
	}

	timelineLabel(label) {
		// Workflow 注释直接写状态名，展示时本地化；普通意见原文展示。
		return STATE_LABELS[label] || __(label);
	}

	openLaunchDialog() {
		const dialog = new frappe.ui.Dialog({
			title: "发起费用报销",
			fields: [
				{fieldname: "subject", label: "报销事项", fieldtype: "Data", reqd: 1},
				{fieldname: "amount", label: "金额", fieldtype: "Currency", reqd: 1},
				{fieldname: "expense_date", label: "费用日期", fieldtype: "Date", default: frappe.datetime.get_today(), reqd: 1},
				{fieldtype: "Column Break"},
				{fieldname: "department", label: "部门", fieldtype: "Data"},
				{fieldname: "cost_center", label: "成本归属", fieldtype: "Data"},
				{fieldtype: "Section Break"},
				{fieldname: "purpose", label: "用途说明", fieldtype: "Small Text", reqd: 1},
			],
			primary_action_label: "提交审批",
			primary_action: async (values) => {
				dialog.disable_primary_action();
				try {
					const instance = await frappe.xcall("shangshu_flow.api.create_expense_request", values);
					dialog.hide();
					frappe.show_alert({message: `已提交，进入经理审批：${instance.doc.name}`, indicator: "green"});
					await this.load();
					this.openInstance(instance.doc.name);
				} finally {
					dialog.enable_primary_action();
				}
			},
		});
		dialog.show();
	}

	async openInstance(name) {
		const $layer = this.$root.find(".ss-instance-layer");
		$layer.attr("aria-hidden", "false").html('<div class="ss-instance-panel"><div class="ss-loading">正在读取实例…</div></div>');
		let data;
		try {
			data = await frappe.xcall("shangshu_flow.api.get_instance", {name});
		} catch (error) {
			$layer.attr("aria-hidden", "true").empty();
			frappe.msgprint({title: "无法读取实例", message: String(error.message || error), indicator: "red"});
			return;
		}
		const doc = data.doc;
		const esc = frappe.utils.escape_html;
		const sizeLabel = (bytes) => {
			try {
				return frappe.form.formatters.FileSize(bytes || 0);
			} catch (error) {
				return `${bytes || 0} B`;
			}
		};
		$layer.html(`
			<div class="ss-instance-scrim"></div>
			<section class="ss-instance-panel">
				<header>
					<button class="ss-icon-button ss-close">${frappe.utils.icon("close", "md")}</button>
					<div><small>${esc(doc.name)}</small><h3>${esc(doc.subject)}</h3></div>
					<i class="ss-status is-${esc(this.stateClass(doc.workflow_state))}">${esc(this.stateLabel(doc.workflow_state))}</i>
				</header>
				<div class="ss-instance-body">
					<div class="ss-journey">${data.journey.map((step) => `<div class="is-${step.status}"><i></i><span><strong>${esc(step.label)}</strong><small>${esc(step.owner)}</small></span></div>`).join("")}</div>
					<div class="ss-current-node"><span>现在</span><strong>${esc(this.stateLabel(doc.workflow_state))}</strong><small>${esc(data.current_node.next_hint)}</small></div>
					<div class="ss-detail-grid">
						<label>申请人<strong>${esc(this.userLabel(doc.applicant))}</strong></label>
						<label>费用日期<strong>${frappe.datetime.str_to_user(doc.expense_date)}</strong></label>
						<label>部门<strong>${esc(doc.department || "—")}</strong></label>
						<label>金额<strong class="ss-large-money">${format_currency(doc.amount, "CNY")}</strong></label>
					</div>
					<div class="ss-detail-block"><span>用途说明</span><p>${esc(doc.purpose || "—")}</p></div>
					<div class="ss-attachments">
						<span>附件（${data.attachments.length}）</span>
						<div class="ss-attachment-list">${data.attachments.map((file) => `<a href="${esc(file.file_url)}" target="_blank">${frappe.utils.icon("file", "sm")}${esc(file.file_name || file.file_url)}<small>${sizeLabel(file.file_size)}</small></a>`).join("") || '<p class="ss-muted">暂无附件</p>'}</div>
						<button class="ss-secondary ss-upload">${frappe.utils.icon("attachment", "sm")}上传附件</button>
					</div>
					<div class="ss-ai-result"><span>${frappe.utils.icon("star", "sm")}<b>AI 处理结果</b></span><p>${esc(doc.ai_summary || "尚未生成处理结果。AI 可在获得确认后补充摘要、检查材料或给出下一步建议。")}</p></div>
					<div class="ss-timeline"><h4>流程时间线</h4>${data.timeline.map((item) => `<div class="is-${esc(item.type)}"><i></i><span><strong>${esc(this.timelineLabel(item.label))}</strong><small>${esc(this.userLabel(item.by))} · ${frappe.datetime.prettyDate(item.at)}</small></span></div>`).join("")}</div>
				</div>
				<footer>
					<button class="ss-secondary ss-ai-help">AI 帮我处理</button>
					${data.actions.map((action) => `<button class="${action.action === "Reject" ? "ss-primary ss-danger" : "ss-primary"}" data-action="${esc(action.action)}">${esc(action.label)}</button>`).join("")}
				</footer>
			</section>`);
		$layer.find(".ss-close,.ss-instance-scrim").on("click", () => $layer.attr("aria-hidden", "true").empty());
		$layer.find(".ss-ai-help").on("click", () => frappe.msgprint({title: "AI 办理接口", message: "这里接收当前实例、节点、字段与可用工具上下文。任何写操作都会先生成确认卡，再调用工作流动作；当前为接口样例，未接入真实模型。", indicator: "blue"}));
		$layer.find(".ss-upload").on("click", () => this.uploadAttachment(name));
		$layer.find("[data-action]").on("click", (event) => this.confirmAction(name, event.currentTarget.dataset.action));
	}

	uploadAttachment(name) {
		new frappe.ui.FileUploader({
			doctype: "Expense Request",
			docname: name,
			as_private: 1,
			on_success: () => this.openInstance(name),
		});
	}

	actionNote(action) {
		// 退回必须留意见；提交/通过允许附言。
		return action === "Reject";
	}

	confirmAction(name, action) {
		const label = ({Submit: "提交审批", "Manager Approve": "经理通过", "Finance Approve": "财务通过", Reject: "退回"})[action] || action;
		const requireNote = this.actionNote(action);
		const dialog = new frappe.ui.Dialog({
			title: `确认「${label}」`,
			fields: [
				{
					fieldname: "note",
					fieldtype: "Small Text",
					label: requireNote ? "退回原因（必填）" : "办理意见（可选）",
					reqd: requireNote ? 1 : 0,
				},
			],
			primary_action_label: `确认${label}`,
			primary_action: async (values) => {
				dialog.disable_primary_action();
				try {
					await frappe.xcall("shangshu_flow.api.apply_action", {name, action, note: values.note || null});
					frappe.show_alert({message: "流程已更新", indicator: "green"});
					dialog.hide();
					await this.load();
					this.openInstance(name);
				} catch (error) {
					frappe.msgprint({title: "操作失败", message: String(error.message || error), indicator: "red"});
				} finally {
					dialog.enable_primary_action();
				}
			},
		});
		dialog.show();
	}
}
