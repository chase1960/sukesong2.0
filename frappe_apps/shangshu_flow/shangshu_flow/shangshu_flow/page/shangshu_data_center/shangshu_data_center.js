frappe.pages["shangshu-data-center"].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({parent: wrapper, title: "数据", single_column: true});
	$(wrapper).find(".page-head").hide();
	wrapper.shangshu_data_center = new ShangshuDataCenter(wrapper);
};

frappe.pages["shangshu-data-center"].on_page_show = (wrapper) => wrapper.shangshu_data_center?.load();

class ShangshuDataCenter {
	constructor(wrapper) {
		this.$host = $(wrapper).find(".layout-main-section");
		this.shell = ShangshuPlatform.mount(this.$host, {active: "data", title: "数据", subtitle: "先按业务应用找数据，需要时再查看字段和技术元数据。"});
		this.state = {status: "", search: ""};
	}

	async load() {
		this.shell.$content.html('<div class="ss-loading">正在读取业务数据…</div>');
		this.data = await frappe.xcall("shangshu_flow.api.get_data_center", this.state);
		this.render();
	}

	render() {
		const esc = frappe.utils.escape_html;
		const labels = {Draft: "草稿", "Pending Manager Approval": "待经理审批", "Pending Finance Review": "待财务审批", Approved: "已通过", Rejected: "已退回"};
		this.shell.$content.html(`<section class="ss-data-page">
			<aside class="ss-data-catalog"><header><strong>业务数据</strong><small>1 个可用数据集</small></header><button class="is-active"><i>${frappe.utils.icon("expenses", "md")}</i><span><strong>费用报销单</strong><small>来自费用报销应用</small></span><em>${this.data.total}</em></button><div class="ss-data-plugin-slot"><strong>安装应用后自动增加</strong><span>财会、文件、客户等插件在这里注册自己的数据集。</span></div></aside>
			<main class="ss-data-table"><header><div><span>费用报销</span><h2>费用报销单</h2><p>每一行都是一张真实单据；状态来自正在运行的审批流程。</p></div><div class="ss-header-btns"><button class="ss-secondary ss-ai-data">${frappe.utils.icon("star", "sm")}AI 设计数据集</button><button class="ss-secondary ss-export">导出 CSV</button><button class="ss-secondary ss-fields">${frappe.utils.icon("table", "sm")}字段说明</button></div></header>
			<div class="ss-data-toolbar"><label>${frappe.utils.icon("search", "sm")}<input class="ss-data-search" placeholder="搜索事项、编号或申请人" value="${esc(this.state.search)}"></label><select class="ss-data-status"><option value="">全部状态</option>${Object.entries(labels).map(([value,label]) => `<option value="${value}" ${value === this.state.status ? "selected" : ""}>${label}</option>`).join("")}</select><button class="ss-primary ss-launch-expense">${frappe.utils.icon("add", "sm")}发起报销</button></div>
			<div class="ss-data-counts">${Object.entries(this.data.counts).map(([key, value]) => `<span>${labels[key] || key}<b>${value}</b></span>`).join("")}</div>
			<div class="ss-data-grid"><div class="ss-data-head"><span>报销事项</span><span>申请人</span><span>金额</span><span>费用日期</span><span>状态</span><span></span></div>${this.data.rows.map((row) => `<button data-name="${esc(row.name)}"><span><strong>${esc(row.subject)}</strong><small>${esc(row.name)}</small></span><span>${esc(row.applicant_name || row.applicant)}</span><span class="ss-money">${format_currency(row.amount, "CNY")}</span><span>${frappe.datetime.str_to_user(row.expense_date)}</span><span><i class="ss-status is-${esc(String(row.workflow_state || "unknown").replace(/\s+/g, "-"))}">${labels[row.workflow_state] || __(row.workflow_state)}</i></span><span>${frappe.utils.icon("right", "sm")}</span></button>`).join("") || '<div class="ss-data-empty"><strong>没有匹配的报销单</strong><span>调整搜索或状态筛选，也可以直接发起一张新单。</span></div>'}</div>
			<footer><span>当前可见 ${this.data.rows.length} / ${this.data.total} 条</span><small>列表结果已按当前用户的数据权限过滤</small></footer></main>
		</section>`);
		this.bind();
	}

	bind() {
		let timer;
		this.shell.$content.find(".ss-data-search").on("input", (event) => { clearTimeout(timer); timer = setTimeout(() => { this.state.search = event.target.value.trim(); this.load(); }, 300); });
		this.shell.$content.find(".ss-data-status").on("change", (event) => { this.state.status = event.target.value; this.load(); });
		this.shell.$content.find("[data-name]").on("click", (event) => { sessionStorage.setItem("shangshu.open_instance", event.currentTarget.dataset.name); frappe.set_route("shangshu-process-center"); });
		this.shell.$content.find(".ss-launch-expense").on("click", () => { sessionStorage.setItem("shangshu.launch_expense", "1"); frappe.set_route("shangshu-process-center"); });
		this.shell.$content.find(".ss-fields").on("click", () => {
			const rows = this.data.fields.map((field) => `<tr><td>${frappe.utils.escape_html(field.label)}</td><td><code>${frappe.utils.escape_html(field.fieldname)}</code></td><td>${frappe.utils.escape_html(field.fieldtype)}</td><td>${field.required ? "必填" : "可选"}</td></tr>`).join("");
			frappe.msgprint({title: "费用报销单字段", message: `<div class="ss-field-help"><p>这是当前数据集的真实 DocType 元数据；普通用户无需先理解它也能查数和办流程。</p><table><thead><tr><th>业务字段</th><th>技术字段</th><th>类型</th><th>约束</th></tr></thead><tbody>${rows}</tbody></table></div>`, wide: true});
		});
		this.shell.$content.find(".ss-ai-data").on("click", () => ShangshuPlatform.placeholder("AI 设计数据集", "这里将读取当前对象字段、视图、动作与权限，生成结构化变更提案；用户确认并通过兼容性检查后才能发布。"));
		this.shell.$content.find(".ss-export").on("click", () => this.exportCsv());
	}

	exportCsv() {
		const safe = (value) => {
			let text = String(value ?? "");
			if (/^[=+\-@]/.test(text)) text = `'${text}`;
			return `"${text.replace(/"/g, '""')}"`;
		};
		const lines = [["单号", "报销事项", "申请人", "金额", "费用日期", "流程状态"], ...this.data.rows.map((row) => [row.name, row.subject, row.applicant_name || row.applicant, row.amount, row.expense_date, row.workflow_state])];
		const blob = new Blob(["\ufeff" + lines.map((line) => line.map(safe).join(",")).join("\n")], {type: "text/csv;charset=utf-8"});
		const link = document.createElement("a");
		link.href = URL.createObjectURL(blob);
		link.download = `费用报销单-${frappe.datetime.get_today()}.csv`;
		link.click();
		URL.revokeObjectURL(link.href);
	}
}
