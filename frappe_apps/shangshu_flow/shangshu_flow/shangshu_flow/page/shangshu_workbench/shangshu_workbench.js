frappe.pages["shangshu-workbench"].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({parent: wrapper, title: "工作台", single_column: true});
	$(wrapper).find(".page-head").hide();
	wrapper.shangshu_workbench = new ShangshuWorkbench(wrapper);
};

frappe.pages["shangshu-workbench"].on_page_show = (wrapper) => wrapper.shangshu_workbench?.load();

class ShangshuWorkbench {
	constructor(wrapper) {
		this.$host = $(wrapper).find(".layout-main-section");
		this.shell = ShangshuPlatform.mount(this.$host, {
			active: "workbench",
			title: `你好，${frappe.user_info(frappe.session.user)?.fullname || frappe.session.user}`,
			subtitle: "从今天要办的事开始，不需要先理解对象和流程引擎。",
		});
	}

	async load() {
		this.shell.$content.html('<div class="ss-loading">正在整理你的工作…</div>');
		const data = await frappe.xcall("shangshu_flow.api.get_workbench");
		this.render(data);
	}

	render(data) {
		const cards = [
			["pending", "待我处理", data.counts.pending, "现在去办理", "shangshu-process-center"],
			["started", "我发起的", data.counts.started, "查看进度", "shangshu-process-center"],
			["completed", "本期已完成", data.counts.completed, "查看记录", "shangshu-process-center"],
		];
		this.shell.$content.html(`
			<section class="ss-workbench">
				<div class="ss-work-summary">${cards.map(([key, label, count, action, route]) => `<button data-route="${route}" data-tab="${key}"><span>${label}</span><strong>${count}</strong><small>${action} →</small></button>`).join("")}</div>
				<div class="ss-workbench-grid">
					<section><header><div><h2>常用应用</h2><p>安装的业务插件会自动出现在这里</p></div></header><div class="ss-business-apps">
						<button data-route="shangshu-process-center"><i>${frappe.utils.icon("expenses", "lg")}</i><strong>费用报销</strong><small>提交、退回、重提和审批</small><em>可用</em></button>
						<button data-route="shangshu-data-center"><i>${frappe.utils.icon("table", "lg")}</i><strong>业务数据</strong><small>统一查看表格与流程状态</small><em>可用</em></button>
						<button data-placeholder="财会系统"><i>${frappe.utils.icon("expenses", "lg")}</i><strong>财会系统</strong><small>总账、应收、应付与凭证</small><em class="is-planned">插件位</em></button>
						<button data-placeholder="文件管理"><i>${frappe.utils.icon("file", "lg")}</i><strong>文件管理</strong><small>企业文件、权限与版本</small><em class="is-planned">插件位</em></button>
					</div></section>
					<aside><header><h2>快速开始</h2></header><button class="ss-quick-start">${frappe.utils.icon("add", "sm")}发起费用报销<small>经理审批 → 财务复核</small></button><button data-route="shangshu-data-center" class="ss-quick-link">查看全部业务数据</button></aside>
				</div>
			</section>`);
		this.shell.$content.find("[data-route]").on("click", (event) => {
			if (event.currentTarget.dataset.tab) sessionStorage.setItem("shangshu.process_tab", event.currentTarget.dataset.tab);
			frappe.set_route(event.currentTarget.dataset.route);
		});
		this.shell.$content.find("[data-placeholder]").on("click", (event) => ShangshuPlatform.placeholder(event.currentTarget.dataset.placeholder, "这是按插件协议安装的独立业务应用入口，当前未安装对应插件。"));
		this.shell.$content.find(".ss-quick-start").on("click", () => {
			sessionStorage.setItem("shangshu.launch_expense", "1");
			frappe.set_route("shangshu-process-center");
		});
	}
}
