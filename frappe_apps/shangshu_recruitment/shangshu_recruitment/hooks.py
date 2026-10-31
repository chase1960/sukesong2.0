app_name = "shangshu_recruitment"
app_title = "尚书招聘"
app_publisher = "Shangshu"
app_description = "招聘 pipeline：岗位/JD、简历收件、筛选、面试评价、Offer 与入职"
app_email = "dev@shangshu.local"
app_license = "MIT"
required_apps = ["frappe", "shangshu_core", "shangshu_mail", "shangshu_files"]
shangshu_domain_contributions = ["shangshu_recruitment.domain.get_contribution"]
after_install = "shangshu_recruitment.install.setup"
after_migrate = "shangshu_recruitment.install.setup"
# 收件轮询是领域定时任务唯一受权模式：声明任务，任务内只调本域已注册写动作。
scheduler_events = {
    "*/5 * * * *": [
        "shangshu_recruitment.sync.poll_mailboxes",
    ]
}
permission_query_conditions = {
    "Shangshu Recruitment Job": "shangshu_recruitment.service.permission_query",
    "Shangshu Recruitment JD Revision": "shangshu_recruitment.service.revision_permission_query",
    "Shangshu Recruitment Screening Rubric": "shangshu_recruitment.service.revision_permission_query",
    "Shangshu Recruitment Candidate": "shangshu_recruitment.candidate.candidate_permission_query",
    "Shangshu Recruitment Resume": "shangshu_recruitment.candidate.resume_permission_query",
    "Shangshu Recruitment Application": "shangshu_recruitment.application.application_permission_query",
    "Shangshu Recruitment Intake": "shangshu_recruitment.intake.intake_permission_query",
    "Shangshu Recruitment Mailbox": "shangshu_recruitment.mailbox.mailbox_permission_query",
    "Shangshu Recruitment Screening": "shangshu_recruitment.screening.screening_permission_query",
    "Shangshu Recruitment Interview": "shangshu_recruitment.interview.interview_permission_query",
    "Shangshu Recruitment Interview Evaluation": "shangshu_recruitment.interview.evaluation_permission_query",
    "Shangshu Recruitment Offer": "shangshu_recruitment.hire.offer_permission_query",
    "Shangshu Recruitment Onboarding": "shangshu_recruitment.hire.onboarding_permission_query",
}
has_permission = {
    "Shangshu Recruitment Job": "shangshu_recruitment.service.permission",
    "Shangshu Recruitment JD Revision": "shangshu_recruitment.service.permission",
    "Shangshu Recruitment Screening Rubric": "shangshu_recruitment.service.permission",
    "Shangshu Recruitment Candidate": "shangshu_recruitment.candidate.candidate_permission",
    "Shangshu Recruitment Resume": "shangshu_recruitment.candidate.resume_permission",
    "Shangshu Recruitment Application": "shangshu_recruitment.application.application_permission",
    "Shangshu Recruitment Intake": "shangshu_recruitment.intake.intake_permission",
    "Shangshu Recruitment Mailbox": "shangshu_recruitment.mailbox.mailbox_permission",
    "Shangshu Recruitment Screening": "shangshu_recruitment.screening.screening_permission",
    "Shangshu Recruitment Interview": "shangshu_recruitment.interview.interview_permission",
    "Shangshu Recruitment Interview Evaluation": "shangshu_recruitment.interview.evaluation_permission",
    "Shangshu Recruitment Offer": "shangshu_recruitment.hire.offer_permission",
    "Shangshu Recruitment Onboarding": "shangshu_recruitment.hire.onboarding_permission",
}
