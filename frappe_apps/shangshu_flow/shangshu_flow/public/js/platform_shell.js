(function () {
	const esc = (value) => frappe.utils.escape_html(String(value ?? ""));
	const routes = [
		["workbench", "工作台", "home", "shangshu-workbench"],
		["data", "数据", "table", "shangshu-data-center"],
		["process", "流程中心", "notification", "shangshu-process-center"],
		["studio", "流程设计", "workflow", "shangshu-workflow-studio", "System Manager"],
	];

	function icon(name, size = "sm") {
		return frappe.utils.icon(name, size);
	}

	function placeholder(title, detail) {
		frappe.msgprint({
			title,
			message: `<div class="ss-placeholder-dialog"><strong>扩展位已预留，当前版本未接通</strong><p>${esc(detail)}</p><small>接入时必须通过插件清单、命名空间、权限与事件协议，不直接覆盖平台核心。</small></div>`,
			indicator: "blue",
		});
	}

	function mount($host, options = {}) {
		const canDesign = frappe.user.has_role("System Manager");
		const visibleRoutes = routes.filter((item) => !item[4] || canDesign);
		const user = frappe.user_info(frappe.session.user) || {};
		const displayName = user.fullname || frappe.session.user;
		const roleName = canDesign ? "管理员" : "员工";
		const savedCompact = localStorage.getItem("shangshu.sidebar.collapsed") === "1";
		$host.empty().addClass("ss-platform-host").html(`
			<div class="ss-platform-shell ${options.compact || savedCompact ? "is-compact" : ""}">
				<aside class="ss-platform-nav">
					<div class="ss-brand-row">
						<button class="ss-brand" data-route="shangshu-workbench" aria-label="尚书工作台"><img src="/brand-mark.png" alt="尚书"></button>
						<button class="ss-side-toggle" title="收起或展开侧栏" aria-label="收起或展开侧栏"><img src="/brand-seal.png" alt=""><span>${icon("left", "sm")}</span></button>
					</div>
					<div class="ss-platform-nav-scroll">
						<div class="ss-nav-group"><small>核心</small><nav>${visibleRoutes.map(([key, label, itemIcon, route]) => `<button data-route="${route}" class="${options.active === key ? "is-active" : ""}" title="${label}">${icon(itemIcon)}<span>${label}</span></button>`).join("")}</nav></div>
						<div class="ss-nav-section"><small>协作</small>
						<button data-placeholder="消息" title="消息">${icon("mail")}<span>消息</span><i>待接入</i></button>
						<button data-placeholder="任务" title="任务">${icon("check")}<span>任务</span><i>待接入</i></button>
						</div>
					</div>
					<div class="ss-nav-footer">
						<div class="ss-account-menu" hidden>
							<button data-placeholder="应用管理">${icon("customization")}<span>应用管理</span></button>
							<button data-placeholder="企业设置">${icon("users")}<span>企业设置</span></button>
							<button class="ss-logout">${icon("arrow-left")}<span>退出登录</span></button>
						</div>
						<button class="ss-user" aria-expanded="false"><b>${esc(displayName.slice(0, 1))}</b><span>${esc(displayName)}<em>${roleName}</em></span>${icon("up", "xs")}</button>
					</div>
				</aside>
				<section class="ss-platform-main">
					<header class="ss-platform-topbar"><div><h1>${esc(options.title || "尚书")}</h1><p>${esc(options.subtitle || "")}</p></div><div class="ss-platform-actions"></div></header>
					<main class="ss-platform-content"></main>
				</section>
				<button class="ss-global-ai" title="在当前页面询问尚书">${icon("star")}<span>问尚书</span></button>
			</div>`);
		$host.find("[data-route]").on("click", (event) => frappe.set_route(event.currentTarget.dataset.route));
		$host.find(".ss-side-toggle").on("click", () => {
			const shell = $host.find(".ss-platform-shell");
			const compact = !shell.hasClass("is-compact");
			shell.toggleClass("is-compact", compact);
			localStorage.setItem("shangshu.sidebar.collapsed", compact ? "1" : "0");
		});
		$host.find(".ss-user").on("click", (event) => {
			event.stopPropagation();
			const menu = $host.find(".ss-account-menu");
			const open = menu.is("[hidden]");
			menu.prop("hidden", !open);
			$(event.currentTarget).attr("aria-expanded", String(open));
		});
		$(document).off("click.shangshu-account").on("click.shangshu-account", () => {
			$host.find(".ss-account-menu").prop("hidden", true);
			$host.find(".ss-user").attr("aria-expanded", "false");
		});
		$host.find(".ss-logout").on("click", () => frappe.app.logout());
		$host.find("[data-placeholder]").on("click", (event) => {
			const name = event.currentTarget.dataset.placeholder;
			const detail = name === "应用管理"
				? "这里将展示已安装插件、版本、权限申请、依赖关系、启停与升级记录。"
				: name === "企业设置"
					? "这里将管理组织、成员、角色、数据域和企业级策略。"
					: `旧版 ${name} 模块仍保留在 Node 应用中；统一身份和插件协议完成后再迁入当前产品壳。`;
			placeholder(name, detail);
		});
		$host.find(".ss-global-ai").on("click", () => placeholder("AI 助手接口", "助手将获得当前页面、选中记录、当前流程节点和当前用户可用工具；读取可直接回答，所有写操作仍先生成确认卡。当前 Frappe 平台壳尚未接入真实模型。"));
		return {
			$content: $host.find(".ss-platform-content"),
			$actions: $host.find(".ss-platform-actions"),
		};
	}

	window.ShangshuPlatform = {mount, placeholder};
})();
