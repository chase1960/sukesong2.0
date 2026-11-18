/* 演示快照：2026-11-18 由本地真实服务端抓取，仅用于静态体验。 */
window.__DEMO_API__ = {
  "GET /api/session": {
    "authed": true,
    "user": {
      "username": "admin",
      "role": "admin",
      "display_name": "管理员"
    }
  },
  "GET /api/hr/overview": {
    "generated_at": "2026-11-18T16:23:33.926Z",
    "headline": [
      {
        "key": "headcount",
        "label": "在职人数",
        "value": 10,
        "unit": "人",
        "hint": "编制 55 人 · 缺口 45",
        "tone": "blue"
      },
      {
        "key": "assets",
        "label": "员工数据资产覆盖度",
        "value": 64,
        "unit": "分",
        "hint": "事实 17 条 · 已核实 17",
        "tone": "amber"
      },
      {
        "key": "cph",
        "label": "单人招聘成本",
        "value": 8788,
        "unit": "元",
        "hint": "AI 抵扣 ¥1188 · 质量率 69%",
        "tone": "amber"
      },
      {
        "key": "ai",
        "label": "AI 独立处理",
        "value": 0,
        "unit": "次",
        "hint": "L1/L2 决策 0 次 · 待确认 0",
        "tone": "blue"
      },
      {
        "key": "twin",
        "label": "数字分身可用率",
        "value": 50,
        "unit": "%",
        "hint": "3 个在授权 · 拒答 3 次",
        "tone": "amber"
      },
      {
        "key": "knowledge",
        "label": "知识采纳率",
        "value": 60,
        "unit": "%",
        "hint": "4 条已发布 · 复用 10 次",
        "tone": "green"
      }
    ],
    "workforce": {
      "headcount": 10,
      "by_dept": [
        {
          "dept": "研发中心",
          "headcount": 5,
          "facts": 11,
          "completeness": 346,
          "low": 1,
          "avg_completeness": 69
        },
        {
          "dept": "产品部",
          "headcount": 2,
          "facts": 3,
          "completeness": 133,
          "low": 1,
          "avg_completeness": 67
        },
        {
          "dept": "人力资源部",
          "headcount": 1,
          "facts": 2,
          "completeness": 68,
          "low": 0,
          "avg_completeness": 68
        },
        {
          "dept": "市场部",
          "headcount": 1,
          "facts": 1,
          "completeness": 58,
          "low": 1,
          "avg_completeness": 58
        },
        {
          "dept": "财务部",
          "headcount": 1,
          "facts": 0,
          "completeness": 32,
          "low": 1,
          "avg_completeness": 32
        }
      ],
      "tenure": [
        {
          "bucket": "<1 年",
          "count": 0
        },
        {
          "bucket": "1-3 年",
          "count": 2
        },
        {
          "bucket": "3-5 年",
          "count": 2
        },
        {
          "bucket": "5 年以上",
          "count": 6
        }
      ],
      "levels": [
        {
          "level": "P7",
          "count": 4
        },
        {
          "level": "P6",
          "count": 3
        },
        {
          "level": "P5",
          "count": 2
        },
        {
          "level": "P8",
          "count": 1
        }
      ],
      "org": {
        "units": [
          {
            "dept": "研发中心",
            "budget": 26,
            "onboard": 22,
            "open": 4,
            "usage": 85,
            "cost_budget": 6200000
          },
          {
            "dept": "产品部",
            "budget": 10,
            "onboard": 8,
            "open": 2,
            "usage": 80,
            "cost_budget": 2400000
          },
          {
            "dept": "人力资源部",
            "budget": 6,
            "onboard": 5,
            "open": 1,
            "usage": 83,
            "cost_budget": 1200000
          },
          {
            "dept": "市场部",
            "budget": 8,
            "onboard": 7,
            "open": 1,
            "usage": 88,
            "cost_budget": 1800000
          },
          {
            "dept": "财务部",
            "budget": 5,
            "onboard": 4,
            "open": 1,
            "usage": 80,
            "cost_budget": 900000
          }
        ],
        "budget_total": 55,
        "onboard_total": 46
      },
      "fact_kinds": [
        {
          "kind": "project",
          "label": "项目经历",
          "count": 8
        },
        {
          "kind": "performance",
          "label": "绩效结果",
          "count": 3
        },
        {
          "kind": "training",
          "label": "学习记录",
          "count": 2
        },
        {
          "kind": "feedback",
          "label": "协作反馈",
          "count": 2
        },
        {
          "kind": "award",
          "label": "荣誉奖励",
          "count": 0
        },
        {
          "kind": "skill_demo",
          "label": "能力实证",
          "count": 1
        },
        {
          "kind": "knowledge",
          "label": "经验贡献",
          "count": 1
        }
      ],
      "grade_distribution": {
        "A": 1,
        "B": 1,
        "C": 7,
        "D": 1
      }
    },
    "assets": {
      "avg_completeness": 64,
      "facts_total": 17,
      "facts_per_employee": 1.7,
      "thin_profiles": [
        {
          "id": "96d09e49-6cd9-4527-b817-5e8a5a9dd878",
          "name": "吴静",
          "dept": "财务部",
          "score": 32,
          "hints": [
            "补齐姓名/部门/岗位/职级/上级/入职日期",
            "至少登记 3 项能力及熟练度（1-5 级）",
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
          ]
        },
        {
          "id": "fb18a808-3454-48e0-a8d4-a4ed109c8437",
          "name": "郑凯",
          "dept": "研发中心",
          "score": 56,
          "hints": [
            "补齐姓名/部门/岗位/职级/上级/入职日期",
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）"
          ]
        },
        {
          "id": "72c0b1b6-49c9-4f1d-bbe4-ca6d9f324d41",
          "name": "陈晨",
          "dept": "产品部",
          "score": 58,
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划"
          ]
        },
        {
          "id": "a5c044df-2b9a-4dc2-bbac-f4aaec661a11",
          "name": "孙悦",
          "dept": "市场部",
          "score": 58,
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划"
          ]
        },
        {
          "id": "1d89b559-ea5d-49dc-bea8-d92cd7c793bc",
          "name": "周杰",
          "dept": "研发中心",
          "score": 64,
          "hints": [
            "至少登记 3 项能力及熟练度（1-5 级）",
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）"
          ]
        },
        {
          "id": "5e241d85-7620-47b6-a251-953742095750",
          "name": "李娜",
          "dept": "研发中心",
          "score": 68,
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划"
          ]
        },
        {
          "id": "b9b2dc25-5bce-4fd2-910d-1c88dd1553ce",
          "name": "赵敏",
          "dept": "人力资源部",
          "score": 68,
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划"
          ]
        },
        {
          "id": "41a44afd-1051-4b22-8028-34828f327b7b",
          "name": "刘洋",
          "dept": "研发中心",
          "score": 68,
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "把一条项目经验沉淀为知识卡片"
          ]
        }
      ],
      "skills": [
        {
          "name": "数据分析",
          "people": 4,
          "avg_level": 2.3
        },
        {
          "name": "Java",
          "people": 3,
          "avg_level": 3.7
        },
        {
          "name": "稳定性",
          "people": 3,
          "avg_level": 3
        },
        {
          "name": "分布式",
          "people": 2,
          "avg_level": 3
        },
        {
          "name": "数据库",
          "people": 2,
          "avg_level": 3.5
        },
        {
          "name": "需求分析",
          "people": 2,
          "avg_level": 4
        },
        {
          "name": "项目管理",
          "people": 2,
          "avg_level": 3.5
        },
        {
          "name": "用户研究",
          "people": 2,
          "avg_level": 3.5
        },
        {
          "name": "代码评审",
          "people": 1,
          "avg_level": 4
        },
        {
          "name": "灰度发布",
          "people": 1,
          "avg_level": 4
        },
        {
          "name": "TypeScript",
          "people": 1,
          "avg_level": 4
        },
        {
          "name": "React",
          "people": 1,
          "avg_level": 3
        }
      ],
      "twins_active": 3,
      "knowledge_published": 4,
      "plans_active": 2
    },
    "recruitment": {
      "funnel": [
        {
          "key": "sourced",
          "label": "触达/投递",
          "value": 462
        },
        {
          "key": "screened",
          "label": "初筛通过",
          "value": 182
        },
        {
          "key": "interviewed",
          "label": "进入面试",
          "value": 96
        },
        {
          "key": "offers",
          "label": "发出 Offer",
          "value": 35
        },
        {
          "key": "hired",
          "label": "成功入职",
          "value": 29
        }
      ],
      "stages": [
        {
          "key": "sourced",
          "label": "触达/投递",
          "value": 462,
          "rate_from_prev": 100,
          "rate_from_top": 100
        },
        {
          "key": "screened",
          "label": "初筛通过",
          "value": 182,
          "rate_from_prev": 39,
          "rate_from_top": 39
        },
        {
          "key": "interviewed",
          "label": "进入面试",
          "value": 96,
          "rate_from_prev": 53,
          "rate_from_top": 21
        },
        {
          "key": "offers",
          "label": "发出 Offer",
          "value": 35,
          "rate_from_prev": 36,
          "rate_from_top": 8
        },
        {
          "key": "hired",
          "label": "成功入职",
          "value": 29,
          "rate_from_prev": 83,
          "rate_from_top": 6
        }
      ],
      "totals": {
        "spend": 216000,
        "internal_hours": 182,
        "internal_cost": 40040,
        "total_cost": 256040,
        "hires": 29,
        "cost_per_hire": 8829,
        "ai_adjusted_cost_per_hire": 8788,
        "quality_rate": 69,
        "ai_hours_saved": 5.4,
        "ai_value_saved": 1188,
        "ai_screen_rate": 65,
        "avg_cpa": 7448,
        "offer_accept_rate": 83
      },
      "quality": {
        "best_channel": "猎头合作",
        "best_channel_rate": 100,
        "note": "质量口径：入职 90 天通过试用期/首评达标的人数 ÷ 入职人数。价格便宜的渠道，如果试用期流失高，真实成本会翻倍。"
      },
      "channels": [
        {
          "id": "02d8bf4e-9eaf-49e4-ac83-e6187996555c",
          "name": "员工内推",
          "type": "内部",
          "spend": 32000,
          "sourced": 42,
          "screened": 26,
          "interviewed": 16,
          "offers": 8,
          "hired": 7,
          "quality_hires": 6,
          "cpa": 4571,
          "screen_rate": 62,
          "interview_rate": 62,
          "offer_rate": 50,
          "accept_rate": 88,
          "quality_rate": 86,
          "cost_per_quality_hire": 5333,
          "internal_hours": 36,
          "status": "active"
        },
        {
          "id": "9dd04929-51f2-4730-8035-eaea2500c7a3",
          "name": "招聘网站 A",
          "type": "外部平台",
          "spend": 50000,
          "sourced": 210,
          "screened": 64,
          "interviewed": 28,
          "offers": 9,
          "hired": 7,
          "quality_hires": 3,
          "cpa": 7143,
          "screen_rate": 30,
          "interview_rate": 44,
          "offer_rate": 32,
          "accept_rate": 78,
          "quality_rate": 43,
          "cost_per_quality_hire": 16667,
          "internal_hours": 64,
          "status": "active"
        },
        {
          "id": "1bee9028-225b-4a4c-b2f2-ed7cbda17f1b",
          "name": "猎头合作",
          "type": "猎头",
          "spend": 90000,
          "sourced": 26,
          "screened": 18,
          "interviewed": 12,
          "offers": 4,
          "hired": 3,
          "quality_hires": 3,
          "cpa": 30000,
          "screen_rate": 69,
          "interview_rate": 67,
          "offer_rate": 33,
          "accept_rate": 75,
          "quality_rate": 100,
          "cost_per_quality_hire": 30000,
          "internal_hours": 18,
          "status": "active"
        },
        {
          "id": "664469ed-6828-4f8d-9491-4fe63cf25fab",
          "name": "校园招聘",
          "type": "校园",
          "spend": 32000,
          "sourced": 150,
          "screened": 58,
          "interviewed": 30,
          "offers": 10,
          "hired": 8,
          "quality_hires": 5,
          "cpa": 4000,
          "screen_rate": 39,
          "interview_rate": 52,
          "offer_rate": 33,
          "accept_rate": 80,
          "quality_rate": 63,
          "cost_per_quality_hire": 6400,
          "internal_hours": 52,
          "status": "active"
        },
        {
          "id": "244b3ff4-6d60-4405-bba7-5952a776c6e3",
          "name": "行业社群",
          "type": "社群",
          "spend": 12000,
          "sourced": 34,
          "screened": 16,
          "interviewed": 10,
          "offers": 4,
          "hired": 4,
          "quality_hires": 3,
          "cpa": 3000,
          "screen_rate": 47,
          "interview_rate": 63,
          "offer_rate": 40,
          "accept_rate": 100,
          "quality_rate": 75,
          "cost_per_quality_hire": 4000,
          "internal_hours": 12,
          "status": "active"
        }
      ],
      "recommendations": [
        {
          "id": "7f1be3ea-c8a5-4b1f-8766-9e71ce6102a3",
          "kind": "budget_shift",
          "title": "把「猎头合作」的预算向高质量渠道迁移",
          "rationale": "猎头合作 的单人成本 ¥30000，是均值 ¥7448 的 4 倍，且 90 天质量率仅 100%。按同等入职量测算，迁移后可省约 ¥67656。",
          "evidence": {
            "channel": "猎头合作",
            "cpa": 30000,
            "avg_cpa": 7448,
            "quality_rate": 100,
            "spend": 90000,
            "hires": 3
          },
          "expected_saving": 67656,
          "status": "proposed",
          "baseline": {
            "cost_per_hire": 8829,
            "spend": 216000,
            "hires": 29,
            "at": "2026-11-18T09:59:38.211Z"
          },
          "measured": {},
          "created_at": "2026-11-18T09:59:38.211Z",
          "adopted_at": ""
        },
        {
          "id": "72e5ec96-b561-4f02-9cc2-ed4c3be86374",
          "kind": "budget_increase",
          "title": "给「员工内推」加投（质量最高但预算占比低）",
          "rationale": "员工内推 的 90 天质量率 86%、单人成本 ¥3429，但只占预算 11%。加投的边际成本低于在低质量渠道上重复获客。",
          "evidence": {
            "channel": "员工内推",
            "quality_rate": 86,
            "cpa": 3429,
            "spend_share": 11
          },
          "expected_saving": 0,
          "status": "proposed",
          "baseline": {
            "cost_per_hire": 8829,
            "spend": 216000,
            "hires": 29,
            "at": "2026-11-18T09:59:38.209Z"
          },
          "measured": {},
          "created_at": "2026-11-18T09:59:38.209Z",
          "adopted_at": ""
        },
        {
          "id": "88c3a3de-a2e0-4f79-a2f4-ee557d89ac81",
          "kind": "budget_shift",
          "title": "把「招聘网站 A」的预算向高质量渠道迁移",
          "rationale": "招聘网站 A 单人成本约 ¥10,000，是均值 ¥8,057 的 1.24 倍，且 90 天质量率仅 43%，明显低于内推的 86%。",
          "evidence": {
            "channel": "招聘网站 A",
            "cpa": 10000,
            "avg_cpa": 8057,
            "quality_rate": 43,
            "spend": 58000,
            "hires": 7
          },
          "expected_saving": 11000,
          "status": "measured",
          "baseline": {
            "cost_per_hire": 8829,
            "spend": 216000,
            "hires": 29,
            "at": "2026-11-18T10:26:49.644Z",
            "moved": {
              "from": "招聘网站 A",
              "to": "员工内推",
              "amount": 8000
            }
          },
          "measured": {
            "before_cost_per_hire": 8829,
            "after_cost_per_hire": 8829,
            "delta": 0,
            "delta_rate": 0,
            "before_hires": 29,
            "after_hires": 29,
            "note": "一个周期后回测",
            "at": "2026-11-18T10:26:49.691Z",
            "verdict": "暂无变化"
          },
          "created_at": "2026-11-11T09:56:05.083Z",
          "adopted_at": "2026-11-18T10:26:49.644Z"
        },
        {
          "id": "41af55c9-4ef0-4707-af15-83fa15de8249",
          "kind": "ai_screening",
          "title": "把 AI 预筛覆盖率从 65% 提到 90%",
          "rationale": "仍有 35% 的申请靠人工过简历；按每次初筛 25 分钟计，补齐后每批约省 5.8 小时。",
          "evidence": {
            "ai_screen_rate": 65,
            "applications": 20
          },
          "expected_saving": 1276,
          "status": "measured",
          "baseline": {
            "cost_per_hire": 8600,
            "spend": 216000,
            "hires": 16,
            "at": "2026-10-04T09:56:05.085Z"
          },
          "measured": {
            "before_cost_per_hire": 8600,
            "after_cost_per_hire": 8057,
            "delta": 543,
            "delta_rate": 6.3,
            "note": "按同口径重算，AI 抵扣后单个入职成本下降 6.3%",
            "at": "2026-11-15T09:56:05.085Z",
            "verdict": "达标"
          },
          "created_at": "2026-10-04T09:56:05.085Z",
          "adopted_at": "2026-10-04T09:56:05.085Z"
        }
      ],
      "snapshot_at": "2026-11-17T09:56:05.081Z",
      "snapshot_truncated": true
    },
    "capability": {
      "top_gaps": [
        {
          "skill": "分布式",
          "people": 4,
          "total_gap": 14,
          "required": 4,
          "avg_gap": 3.5
        },
        {
          "skill": "数据库",
          "people": 4,
          "total_gap": 13,
          "required": 4,
          "avg_gap": 3.3
        },
        {
          "skill": "灰度发布",
          "people": 4,
          "total_gap": 12,
          "required": 3,
          "avg_gap": 3
        },
        {
          "skill": "代码评审",
          "people": 4,
          "total_gap": 12,
          "required": 3,
          "avg_gap": 3
        },
        {
          "skill": "稳定性",
          "people": 4,
          "total_gap": 11,
          "required": 4,
          "avg_gap": 2.8
        },
        {
          "skill": "Java",
          "people": 3,
          "total_gap": 9,
          "required": 4,
          "avg_gap": 3
        },
        {
          "skill": "数据分析",
          "people": 3,
          "total_gap": 4,
          "required": 4,
          "avg_gap": 1.3
        },
        {
          "skill": "性能测试",
          "people": 1,
          "total_gap": 3,
          "required": 3,
          "avg_gap": 3
        }
      ],
      "skill_people": [
        {
          "name": "数据分析",
          "people": 4,
          "avg_level": 2.3
        },
        {
          "name": "Java",
          "people": 3,
          "avg_level": 3.7
        },
        {
          "name": "稳定性",
          "people": 3,
          "avg_level": 3
        },
        {
          "name": "分布式",
          "people": 2,
          "avg_level": 3
        },
        {
          "name": "数据库",
          "people": 2,
          "avg_level": 3.5
        },
        {
          "name": "需求分析",
          "people": 2,
          "avg_level": 4
        },
        {
          "name": "项目管理",
          "people": 2,
          "avg_level": 3.5
        },
        {
          "name": "用户研究",
          "people": 2,
          "avg_level": 3.5
        },
        {
          "name": "代码评审",
          "people": 1,
          "avg_level": 4
        },
        {
          "name": "灰度发布",
          "people": 1,
          "avg_level": 4
        },
        {
          "name": "TypeScript",
          "people": 1,
          "avg_level": 4
        },
        {
          "name": "React",
          "people": 1,
          "avg_level": 3
        }
      ]
    },
    "learning": {
      "plans_active": 2,
      "completion_rate": 29,
      "hours_total": 16,
      "cost_total": 3520,
      "behavior_rate": 67,
      "uplift_count": 0,
      "kirkpatrick": [
        {
          "level": 1,
          "name": "反应",
          "desc": "学员反馈与完成度",
          "count": 0
        },
        {
          "level": 2,
          "name": "学习",
          "desc": "测评分数与认证",
          "count": 1
        },
        {
          "level": 3,
          "name": "行为",
          "desc": "回到岗位后的行为变化（主管确认）",
          "count": 2
        },
        {
          "level": 4,
          "name": "结果",
          "desc": "对业务指标的影响（项目交付、缺陷率等）",
          "count": 0
        }
      ],
      "roi_note": "投入约 16 小时（¥3,520），当前可验证的能力提升 0 项；建议把未产生行为改变（柯氏 3 级）的课程下架。"
    },
    "knowledge": {
      "published": 4,
      "drafts": 2,
      "usage_total": 10,
      "adoption_rate": 60,
      "top": [
        {
          "id": "036fb7ac-9b5c-44e8-a4f2-3959fc216692",
          "title": "灰度发布：先分租户再分比例，回滚必须一键",
          "usage": 4,
          "adopted": 3,
          "adoption_rate": 75,
          "last_used": "2026-11-14T09:56:05.046Z",
          "dormant": false
        },
        {
          "id": "68b7d041-040f-4203-8a77-c817e2964319",
          "title": "人才盘点：没有事实证据的九宫格都是印象派",
          "usage": 4,
          "adopted": 2,
          "adoption_rate": 50,
          "last_used": "2026-11-18T10:26:27.104Z",
          "dormant": false
        },
        {
          "id": "419080a4-e6d7-4031-8702-38a11d7add97",
          "title": "首屏性能：先砍体积，再谈缓存",
          "usage": 2,
          "adopted": 1,
          "adoption_rate": 50,
          "last_used": "2026-11-10T09:56:05.050Z",
          "dormant": false
        },
        {
          "id": "4f251ad0-b49b-4ad7-820f-b86626cb278d",
          "title": "自动化测试落地：先保回归，再谈覆盖率",
          "usage": 0,
          "adopted": 0,
          "adoption_rate": 0,
          "last_used": "",
          "dormant": true
        }
      ],
      "dormant": [
        {
          "id": "4f251ad0-b49b-4ad7-820f-b86626cb278d",
          "title": "自动化测试落地：先保回归，再谈覆盖率",
          "usage": 0,
          "adopted": 0,
          "adoption_rate": 0,
          "last_used": "",
          "dormant": true
        }
      ],
      "suggestions": [
        {
          "kind": "promote",
          "title": "把「灰度发布：先分租户再分比例，回滚必须一键」提升为标准动作",
          "why": "已复用 4 次，采纳率 75%"
        },
        {
          "kind": "promote",
          "title": "把「人才盘点：没有事实证据的九宫格都是印象派」提升为标准动作",
          "why": "已复用 4 次，采纳率 50%"
        },
        {
          "kind": "archive",
          "title": "「自动化测试落地：先保回归，再谈覆盖率」90 天零引用",
          "why": "建议归档或改写成更具体的场景卡片"
        }
      ]
    },
    "autonomy": {
      "levels": [
        {
          "level": "L0",
          "name": "观察",
          "desc": "只读与看板。AI 可以算、可以展示，不产生任何业务动作。",
          "tone": "gray"
        },
        {
          "level": "L1",
          "name": "建议",
          "desc": "AI 产出建议与草稿，由人自己决定是否采纳、自己做执行。",
          "tone": "blue"
        },
        {
          "level": "L2",
          "name": "单步确认",
          "desc": "AI 准备一条写入，人在确认卡上核对后点一次确认，事务内落库并留审计。",
          "tone": "green"
        },
        {
          "level": "L3",
          "name": "计划确认",
          "desc": "AI 准备多步或批量方案（培养计划、预算调整），人确认整包后按计划执行。",
          "tone": "amber"
        },
        {
          "level": "L4",
          "name": "人主办",
          "desc": "AI 只做材料整理与检索，判断、沟通与执行必须由人完成。",
          "tone": "red"
        }
      ],
      "rows": [
        {
          "action_key": "hr.analytics.view",
          "name": "中台看板与指标",
          "default_level": "L0",
          "risk": "low",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [],
          "why": "只读聚合，不写业务事实",
          "escalate": "导出含个人敏感字段时升级到 L4 授权",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L0",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.asset.ledger",
          "name": "员工资产台账",
          "default_level": "L0",
          "risk": "low",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [],
          "why": "只读资产覆盖度与缺口",
          "escalate": "按人下钻到薪酬结构时升级",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L0",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.twin.answer",
          "name": "数字分身代答",
          "default_level": "L1",
          "risk": "low",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [
            "personal"
          ],
          "why": "限定在本人授权范围内，输出带证据引用",
          "escalate": "越出授权主题或涉及他人评价时直接 L4 拒答",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L1",
          "usage": 1,
          "last_level": "L3",
          "last_at": "2026-10-29T09:56:05.095Z"
        },
        {
          "action_key": "hr.knowledge.recommend",
          "name": "知识推荐",
          "default_level": "L1",
          "risk": "low",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [],
          "why": "只做检索与排序，不改知识内容",
          "escalate": "推荐结果被用作处分依据时升级",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L1",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.recruit.recommend",
          "name": "招聘降本建议",
          "default_level": "L1",
          "risk": "low",
          "reversible": true,
          "blast_radius": "team",
          "sensitivity": [],
          "why": "给建议与测算，不动预算",
          "escalate": "采纳并改预算时升 L3",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L1",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.learning.gap.propose",
          "name": "能力差距与培养计划草稿",
          "default_level": "L1",
          "risk": "low",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [
            "performance"
          ],
          "why": "基于能力模型算差距，草稿可改",
          "escalate": "计划与晋升/调薪挂钩时升 L4",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L1",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.employee.save",
          "name": "员工建档与字段更新",
          "default_level": "L2",
          "risk": "medium",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [
            "personal"
          ],
          "why": "影响一个人的人事事实，需人核对",
          "escalate": "改职级/汇报线/成本中心时升 L3",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L2",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.fact.record",
          "name": "登记员工事实",
          "default_level": "L2",
          "risk": "low",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [
            "performance"
          ],
          "why": "事实会进入画像与 AI 结论，必须人确认后才算数",
          "escalate": "批量导入或跨部门写入时升 L3",
          "policy_level": "L3",
          "policy_reason": "冒烟测试上调门槛",
          "effective_level": "L3",
          "usage": 1,
          "last_level": "L3",
          "last_at": "2026-10-19T09:56:05.091Z"
        },
        {
          "action_key": "hr.fact.verify",
          "name": "核实员工事实",
          "default_level": "L2",
          "risk": "medium",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [
            "performance"
          ],
          "why": "核实等于给证据背书，需责任人签字",
          "escalate": "涉及争议事实时升 L4",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L2",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.learning.event",
          "name": "记录学习完成",
          "default_level": "L2",
          "risk": "low",
          "reversible": true,
          "blast_radius": "self",
          "sensitivity": [],
          "why": "学习记录进入培养效果评估",
          "escalate": "与认证/资格挂钩时升 L3",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L2",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.knowledge.publish",
          "name": "发布知识卡片",
          "default_level": "L2",
          "risk": "low",
          "reversible": true,
          "blast_radius": "team",
          "sensitivity": [],
          "why": "影响团队做法，但有版本可回滚",
          "escalate": "涉及客户信息或对外口径时升 L3",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L2",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.interview.schedule",
          "name": "安排面试",
          "default_level": "L2",
          "risk": "low",
          "reversible": true,
          "blast_radius": "team",
          "sensitivity": [],
          "why": "占用面试官时间，需确认时间与轮次",
          "escalate": "自动改面试结论时升 L4",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L2",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.learning.plan.publish",
          "name": "发布培养计划",
          "default_level": "L3",
          "risk": "medium",
          "reversible": true,
          "blast_radius": "team",
          "sensitivity": [
            "performance"
          ],
          "why": "跨 90 天多步动作，承诺资源与时间",
          "escalate": "计划含晋升承诺时升 L4",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L3",
          "usage": 1,
          "last_level": "L3",
          "last_at": "2026-10-29T09:56:05.099Z"
        },
        {
          "action_key": "hr.recruit.budget.shift",
          "name": "招聘渠道预算调整",
          "default_level": "L3",
          "risk": "medium",
          "reversible": true,
          "blast_radius": "company",
          "sensitivity": [],
          "why": "直接花钱且影响公司整体获客",
          "escalate": "单次调整超过月预算 30% 时升 L4",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L3",
          "usage": 1,
          "last_level": "L3",
          "last_at": "2026-11-11T09:56:05.107Z"
        },
        {
          "action_key": "hr.recruit.batch.screen",
          "name": "批量筛选与批量淘汰",
          "default_level": "L3",
          "risk": "high",
          "reversible": false,
          "blast_radius": "company",
          "sensitivity": [
            "personal"
          ],
          "why": "一次影响多名候选人，且淘汰不可完全撤回",
          "escalate": "命中受保护属性或批量>20 人时升 L4",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L3",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.twin.authorize",
          "name": "数字分身授权",
          "default_level": "L4",
          "risk": "high",
          "reversible": false,
          "blast_radius": "self",
          "sensitivity": [
            "personal"
          ],
          "why": "个人数据边界的让渡，必须本人知情同意",
          "escalate": "授权范围含跨部门可见时需 HR 负责人共同签",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L4",
          "usage": 1,
          "last_level": "L4",
          "last_at": "2026-11-06T09:56:05.103Z"
        },
        {
          "action_key": "hr.offer.approve",
          "name": "录用与 Offer 决定",
          "default_level": "L4",
          "risk": "high",
          "reversible": false,
          "blast_radius": "team",
          "sensitivity": [
            "salary"
          ],
          "why": "涉及薪酬承诺与法律效力",
          "escalate": "超带宽 Offer 需加一级审批",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L4",
          "usage": 2,
          "last_level": "L4",
          "last_at": "2026-11-18T10:26:35.041Z"
        },
        {
          "action_key": "hr.comp.change",
          "name": "调薪与奖金分配",
          "default_level": "L4",
          "risk": "high",
          "reversible": false,
          "blast_radius": "team",
          "sensitivity": [
            "salary"
          ],
          "why": "直接改变个人收入与团队公平",
          "escalate": "一律人主办，AI 只做测算与材料",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L4",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.performance.rating",
          "name": "绩效评级",
          "default_level": "L4",
          "risk": "high",
          "reversible": false,
          "blast_radius": "team",
          "sensitivity": [
            "performance"
          ],
          "why": "评级影响晋升、调薪与去留",
          "escalate": "AI 不得给出评级结论，仅整理证据",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L4",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.exit.process",
          "name": "离职与解除处理",
          "default_level": "L4",
          "risk": "high",
          "reversible": false,
          "blast_radius": "self",
          "sensitivity": [
            "personal"
          ],
          "why": "法律与情绪风险都高",
          "escalate": "一律人主办",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L4",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        },
        {
          "action_key": "hr.discipline",
          "name": "纪律与投诉调查",
          "default_level": "L4",
          "risk": "high",
          "reversible": false,
          "blast_radius": "team",
          "sensitivity": [
            "personal"
          ],
          "why": "涉及事实认定与程序正义",
          "escalate": "一律人主办",
          "policy_level": "",
          "policy_reason": "",
          "effective_level": "L4",
          "usage": 0,
          "last_level": "",
          "last_at": ""
        }
      ],
      "usage": {
        "L0": 0,
        "L1": 0,
        "L2": 0,
        "L3": 4,
        "L4": 3
      },
      "decisions_total": 7,
      "recent": [
        {
          "id": "d3294a30-3171-4fa3-b2f1-ec79c24d0559",
          "action_key": "hr.offer.approve",
          "action_name": "录用与 Offer 决定",
          "level": "L4",
          "reasons": [
            "基线：录用与 Offer 决定默认 L4 级",
            "高风险动作：至少 L3（计划确认）",
            "不可逆动作：至少 L3",
            "影响面为团队级：至少 L2",
            "AI 置信度 93%，未触发上调"
          ],
          "actor": "admin",
          "created_at": "2026-11-18T10:26:35.041Z",
          "subject": "测试"
        },
        {
          "id": "97d7a435-c521-4285-8d86-05a1e01975b9",
          "action_key": "hr.offer.approve",
          "action_name": "录用与 Offer 决定",
          "level": "L4",
          "reasons": [
            "基线：录用与 Offer 决定默认 L4 级",
            "高风险动作：至少 L3（计划确认）",
            "不可逆动作：至少 L3",
            "影响面为团队级：至少 L2"
          ],
          "actor": "zhaomin",
          "created_at": "2026-11-14T09:56:05.114Z",
          "subject": "高级后端 Offer 审批"
        },
        {
          "id": "2873f786-a4a8-4c69-a57b-d997d88a3518",
          "action_key": "hr.recruit.budget.shift",
          "action_name": "招聘渠道预算调整",
          "level": "L3",
          "reasons": [
            "基线：招聘渠道预算调整默认 L3 级",
            "中风险动作：至少 L2（单步确认）",
            "影响面为公司级：至少 L3"
          ],
          "actor": "zhaomin",
          "created_at": "2026-11-11T09:56:05.107Z",
          "subject": "渠道预算调整"
        },
        {
          "id": "ae2db842-f611-47cd-b34e-6533ce199323",
          "action_key": "hr.twin.authorize",
          "action_name": "数字分身授权",
          "level": "L4",
          "reasons": [
            "基线：数字分身授权默认 L4 级",
            "高风险动作：至少 L3（计划确认）",
            "不可逆动作：至少 L3"
          ],
          "actor": "zhaomin",
          "created_at": "2026-11-06T09:56:05.103Z",
          "subject": "王芳分身授权"
        },
        {
          "id": "fbd7de68-9684-428b-a835-4cb53fe65cbc",
          "action_key": "hr.learning.plan.publish",
          "action_name": "发布培养计划",
          "level": "L3",
          "reasons": [
            "基线：发布培养计划默认 L3 级",
            "中风险动作：至少 L2（单步确认）",
            "影响面为团队级：至少 L2"
          ],
          "actor": "zhaomin",
          "created_at": "2026-10-29T09:56:05.099Z",
          "subject": "刘洋 90 天计划"
        },
        {
          "id": "9e8e01b7-cb4e-4046-b3e9-c7bd31c4158b",
          "action_key": "hr.twin.answer",
          "action_name": "数字分身代答",
          "level": "L3",
          "reasons": [
            "基线：数字分身代答默认 L1 级",
            "命中敏感数据（personal），强制抬到 L3",
            "AI 置信度 90%，未触发上调"
          ],
          "actor": "zhaomin",
          "created_at": "2026-10-29T09:56:05.095Z",
          "subject": "王芳分身穿答"
        },
        {
          "id": "73df3279-c7ea-418d-84b0-62bf7a1c3ef7",
          "action_key": "hr.fact.record",
          "action_name": "登记员工事实",
          "level": "L3",
          "reasons": [
            "基线：登记员工事实默认 L2 级",
            "命中敏感数据（performance），强制抬到 L3"
          ],
          "actor": "zhaomin",
          "created_at": "2026-10-19T09:56:05.091Z",
          "subject": "张伟项目事实登记"
        }
      ],
      "pending": []
    },
    "twins": {
      "total": 3,
      "active": 3,
      "ready": 1,
      "answer_rate": 50,
      "answered": 4,
      "refused": 3,
      "insufficient": 1,
      "refusal_topics": [
        {
          "topic": "绩效评级细节",
          "count": 1
        },
        {
          "topic": "离职或求职意向",
          "count": 1
        },
        {
          "topic": "薪酬与奖金",
          "count": 1
        }
      ],
      "coverage_gap": [
        {
          "employee": "王芳",
          "question": "她带过几个实习生？",
          "at": "2026-11-17T09:56:05.071Z"
        }
      ],
      "avg_citations": 1.3,
      "hours_saved": 0.8
    },
    "risks": [
      {
        "level": "medium",
        "title": "4 人数据覆盖度低于 60 分",
        "detail": "画像薄 → 能力差距算不准 → 培养与内部匹配都失真",
        "action": "先补 3 条事实与 3 项能力标签"
      },
      {
        "level": "low",
        "title": "2 人未填直属上级",
        "detail": "审批链会断，L2/L3 确认找不到人",
        "action": "补齐汇报线"
      },
      {
        "level": "low",
        "title": "分身拒答 3 次",
        "detail": "拒答集中在「绩效评级细节」，说明边界生效",
        "action": "无需处理，保持拒答"
      },
      {
        "level": "low",
        "title": "3 次人主办决策",
        "detail": "薪酬/录用/离职等高危动作仍在人工轨道，符合设计",
        "action": "抽查台账确保留痕完整"
      },
      {
        "level": "high",
        "title": "招聘质量率仅 69%",
        "detail": "低价渠道可能把成本转移到试用期流失",
        "action": "按渠道看 quality_rate，先砍低质量渠道"
      }
    ]
  },
  "GET /api/hr/employees": {
    "count": 10,
    "employees": [
      {
        "id": "00cf1602-6f98-4821-bec4-b9b2d3558e0d",
        "emp_no": "E1001",
        "name": "张伟",
        "dept": "研发中心",
        "title": "高级后端工程师",
        "level": "P7",
        "manager": "郑凯",
        "join_date": "2021-03-01",
        "status": "active",
        "location": "苏州",
        "education": "硕士 · 计算机科学",
        "tenure_months": 68,
        "skills": [
          {
            "name": "Java",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "分布式",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "数据库",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "稳定性",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "代码评审",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "灰度发布",
            "level": 4,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 90,
          "grade": "A",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 15,
              "hint": "基本信息完整"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 20,
              "hint": "已登记 6 项能力"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 25,
              "hint": "已核实 5 条事实"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 15,
              "hint": "项目与绩效证据充分"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 0,
              "hint": "登记学习记录，或生成一份 90 天培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 10,
              "hint": "已贡献可复用经验"
            }
          ],
          "hints": [
            "登记学习记录，或生成一份 90 天培养计划"
          ]
        },
        "facts": [
          {
            "id": "b2286210-7482-4afe-a4db-cad100985d21",
            "kind": "project",
            "kind_label": "项目经历",
            "title": "冒烟测试事实",
            "summary": "情境：测试 行动：调用 结果：通过",
            "occurred_at": "2026-11-18",
            "tags": [
              "测试"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "admin",
            "stale": false
          },
          {
            "id": "3d477737-ae03-450b-95cd-393cf32f024f",
            "kind": "feedback",
            "kind_label": "协作反馈",
            "title": "跨部门协作反馈",
            "summary": "情境：与产品、测试共建大促保障机制。行动：每周主持风险对齐会。结果：跨部门升级工单下降 40%。",
            "occurred_at": "2026-10-19",
            "tags": [
              "协作"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          },
          {
            "id": "28afa0a4-3547-4a1c-a489-4ea3622280ce",
            "kind": "project",
            "kind_label": "项目经历",
            "title": "订单中心灰度发布体系落地",
            "summary": "情境：大促前每次全量发布都靠回滚兜底。行动：设计按租户分流的灰度通道，接入自动化卡点与一键回滚。结果：发布回滚率从 6% 降到 0.8%，大促期间零 P0。",
            "occurred_at": "2026-10-09",
            "tags": [
              "灰度发布",
              "稳定性"
            ],
            "evidence_strength": 3,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          },
          {
            "id": "4591fd0a-0413-4736-8e86-722a6e859b23",
            "kind": "knowledge",
            "kind_label": "经验贡献",
            "title": "输出《灰度发布检查清单》",
            "summary": "情境：团队新人重复踩发布坑。行动：把 12 次发布事故整理成 15 项检查清单。结果：被 4 个小组采用，新人独立发布周期从 3 周降到 1 周。",
            "occurred_at": "2026-09-19",
            "tags": [
              "灰度发布",
              "知识管理"
            ],
            "evidence_strength": 3,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          },
          {
            "id": "4d39f893-4807-4a65-bf49-33e448f7b571",
            "kind": "performance",
            "kind_label": "绩效结果",
            "title": "2025 年度绩效 A",
            "summary": "情境：全年负责订单与支付两条核心链路。行动：主导 3 次架构治理，补齐压测基线。结果：核心接口 P99 从 180ms 降到 95ms。",
            "occurred_at": "2026-07-21",
            "tags": [
              "稳定性",
              "数据库"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [
          {
            "id": "036fb7ac-9b5c-44e8-a4f2-3959fc216692",
            "title": "灰度发布：先分租户再分比例，回滚必须一键",
            "reuse_count": 4
          }
        ],
        "plans": [],
        "twin": {
          "id": "3a3589d6-c3ff-430a-bfa1-f227961509b7",
          "status": "active",
          "level": "L1",
          "scope": {
            "topics": [
              "岗位职责",
              "项目经历",
              "技能与专长",
              "协作方式",
              "可提供的帮助"
            ],
            "denied": [
              "薪酬与奖金",
              "绩效评级细节",
              "他人评价",
              "离职或求职意向",
              "健康与婚育",
              "法律与医疗建议",
              "公司未公开信息"
            ],
            "data_policy": {
              "salary": false,
              "performance": "summary_only",
              "others_evaluation": false,
              "personal": false
            }
          },
          "expires_at": "2027-04-17T09:56:05.058Z",
          "interaction_count": 8
        }
      },
      {
        "id": "5e241d85-7620-47b6-a251-953742095750",
        "emp_no": "E1002",
        "name": "李娜",
        "dept": "研发中心",
        "title": "前端工程师",
        "level": "P6",
        "manager": "郑凯",
        "join_date": "2022-07-11",
        "status": "active",
        "location": "苏州",
        "education": "本科 · 软件工程",
        "tenure_months": 52,
        "skills": [
          {
            "name": "TypeScript",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "React",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "性能优化",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "组件化",
            "level": 3,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 68,
          "grade": "C",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 15,
              "hint": "基本信息完整"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 20,
              "hint": "已登记 4 项能力"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 10,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 8,
              "hint": "补充 2 条项目或绩效事实（含结果量化）"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 0,
              "hint": "登记学习记录，或生成一份 90 天培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 10,
              "hint": "已贡献可复用经验"
            }
          ],
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划"
          ]
        },
        "facts": [
          {
            "id": "acc21e44-e9a3-4337-a467-22cac8082894",
            "kind": "project",
            "kind_label": "项目经历",
            "title": "交易页首屏性能优化",
            "summary": "情境：首屏 2.8s，转化率被拖累。行动：拆包 + 图片降级 + 预渲染。结果：首屏 1.4s，转化率提升 3.1pp。",
            "occurred_at": "2026-09-09",
            "tags": [
              "性能优化"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          },
          {
            "id": "e2ac225f-18bb-4524-9a1d-0193b04984c4",
            "kind": "skill_demo",
            "kind_label": "能力实证",
            "title": "组件库 2.0 迁移",
            "summary": "情境：旧组件库样式分散。行动：统一设计令牌，迁移 38 个组件。结果：样式 bug 下降 60%。",
            "occurred_at": "2026-06-21",
            "tags": [
              "组件化"
            ],
            "evidence_strength": 1,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [
          {
            "id": "419080a4-e6d7-4031-8702-38a11d7add97",
            "title": "首屏性能：先砍体积，再谈缓存",
            "reuse_count": 2
          }
        ],
        "plans": [],
        "twin": null
      },
      {
        "id": "e8ddcf78-60d8-4e92-89c2-2e3bf4eabe00",
        "emp_no": "E1003",
        "name": "王芳",
        "dept": "产品部",
        "title": "产品经理",
        "level": "P7",
        "manager": "陈晨",
        "join_date": "2020-09-14",
        "status": "active",
        "location": "上海",
        "education": "硕士 · 工业设计",
        "tenure_months": 74,
        "skills": [
          {
            "name": "需求分析",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "数据分析",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "项目管理",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "用户研究",
            "level": 4,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 75,
          "grade": "B",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 15,
              "hint": "基本信息完整"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 20,
              "hint": "已登记 4 项能力"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 10,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 15,
              "hint": "项目与绩效证据充分"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 10,
              "hint": "有学习记录或进行中的培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 0,
              "hint": "把一条项目经验沉淀为知识卡片"
            }
          ],
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "把一条项目经验沉淀为知识卡片"
          ]
        },
        "facts": [
          {
            "id": "b199f173-e61f-4fd4-b0f3-9477e9ef7cc8",
            "kind": "project",
            "kind_label": "项目经历",
            "title": "会员增长项目",
            "summary": "情境：新客次月留存只有 21%。行动：重构新手任务与权益分层。结果：次月留存提升到 32%。",
            "occurred_at": "2026-08-20",
            "tags": [
              "增长",
              "用户研究"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          },
          {
            "id": "023f7ea0-448d-4a92-9796-346e4abb7469",
            "kind": "performance",
            "kind_label": "绩效结果",
            "title": "2025 年度绩效 A",
            "summary": "情境：负责会员与增长两条线。行动：建立周度漏斗复盘机制。结果：全年 GMV 贡献 +18%。",
            "occurred_at": "2026-07-21",
            "tags": [
              "数据分析"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [],
        "plans": [
          {
            "id": "565eef21-1402-48d3-9a87-6d205d25aa69",
            "target_role": "产品经理",
            "status": "active",
            "created_at": "2026-11-18T10:26:27.022Z"
          }
        ],
        "twin": {
          "id": "5923c1b4-6f08-4886-9d38-170f2da2f6dc",
          "status": "active",
          "level": "L1",
          "scope": {
            "topics": [
              "岗位职责",
              "项目经历",
              "技能与专长",
              "协作方式",
              "可提供的帮助"
            ],
            "denied": [
              "薪酬与奖金",
              "绩效评级细节",
              "他人评价",
              "离职或求职意向",
              "健康与婚育",
              "法律与医疗建议",
              "公司未公开信息"
            ],
            "data_policy": {
              "salary": false,
              "performance": "summary_only",
              "others_evaluation": false,
              "personal": false
            }
          },
          "expires_at": "2027-05-05T09:56:05.060Z",
          "interaction_count": 3
        }
      },
      {
        "id": "72c0b1b6-49c9-4f1d-bbe4-ca6d9f324d41",
        "emp_no": "E1004",
        "name": "陈晨",
        "dept": "产品部",
        "title": "高级产品经理",
        "level": "P7",
        "manager": "王芳",
        "join_date": "2019-05-06",
        "status": "active",
        "location": "上海",
        "education": "本科 · 市场学",
        "tenure_months": 90,
        "skills": [
          {
            "name": "需求分析",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "数据分析",
            "level": 2,
            "last_used_at": ""
          },
          {
            "name": "项目管理",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "用户研究",
            "level": 3,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 58,
          "grade": "C",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 15,
              "hint": "基本信息完整"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 20,
              "hint": "已登记 4 项能力"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 10,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 8,
              "hint": "补充 2 条项目或绩效事实（含结果量化）"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 0,
              "hint": "登记学习记录，或生成一份 90 天培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 0,
              "hint": "把一条项目经验沉淀为知识卡片"
            }
          ],
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划",
            "把一条项目经验沉淀为知识卡片"
          ]
        },
        "facts": [
          {
            "id": "6896e7ac-ff87-4142-a992-730e93500ec6",
            "kind": "project",
            "kind_label": "项目经历",
            "title": "B 端工作台改版",
            "summary": "情境：客户投诉操作路径长。行动：访谈 12 家客户，重排信息架构。结果：任务完成时长下降 35%。",
            "occurred_at": "2026-08-10",
            "tags": [
              "用户研究"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [],
        "plans": [],
        "twin": {
          "id": "90c3e07a-09fb-49a7-a021-d6ed3fad3840",
          "status": "active",
          "level": "L1",
          "scope": {
            "topics": [
              "岗位职责",
              "项目经历",
              "技能与专长",
              "协作方式",
              "可提供的帮助",
              "成长与学习"
            ],
            "denied": [
              "薪酬与奖金",
              "绩效评级细节",
              "他人评价",
              "离职或求职意向",
              "健康与婚育",
              "法律与医疗建议",
              "公司未公开信息"
            ],
            "data_policy": {
              "salary": false,
              "performance": "summary_only",
              "others_evaluation": false,
              "personal": false
            }
          },
          "expires_at": "2027-02-16T10:24:29.219Z",
          "interaction_count": 0
        }
      },
      {
        "id": "b9b2dc25-5bce-4fd2-910d-1c88dd1553ce",
        "emp_no": "E1005",
        "name": "赵敏",
        "dept": "人力资源部",
        "title": "HRBP",
        "level": "P6",
        "manager": "吴静",
        "join_date": "2021-11-01",
        "status": "active",
        "location": "苏州",
        "education": "硕士 · 人力资源管理",
        "tenure_months": 60,
        "skills": [
          {
            "name": "人才盘点",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "组织诊断",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "劳动关系",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "数据分析",
            "level": 2,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 68,
          "grade": "C",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 15,
              "hint": "基本信息完整"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 20,
              "hint": "已登记 4 项能力"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 10,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 8,
              "hint": "补充 2 条项目或绩效事实（含结果量化）"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 0,
              "hint": "登记学习记录，或生成一份 90 天培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 10,
              "hint": "已贡献可复用经验"
            }
          ],
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划"
          ]
        },
        "facts": [
          {
            "id": "71de9a6c-81af-4c8f-ac78-6517e81d35d6",
            "kind": "project",
            "kind_label": "项目经历",
            "title": "研发中心人才盘点",
            "summary": "情境：晋升评审缺少证据。行动：设计九宫格 + 事实证据卡。结果：盘点覆盖 100%，争议复议下降一半。",
            "occurred_at": "2026-10-04",
            "tags": [
              "人才盘点"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          },
          {
            "id": "09d3ebd7-40df-4cf7-a033-f032c76a2e52",
            "kind": "feedback",
            "kind_label": "协作反馈",
            "title": "业务部门满意度",
            "summary": "情境：招聘与培养脱节。行动：把岗位能力模型接进面试评分表。结果：试用期不达标率从 15% 降到 7%。",
            "occurred_at": "2026-09-24",
            "tags": [
              "组织诊断",
              "招聘"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [
          {
            "id": "68b7d041-040f-4203-8a77-c817e2964319",
            "title": "人才盘点：没有事实证据的九宫格都是印象派",
            "reuse_count": 4
          }
        ],
        "plans": [],
        "twin": null
      },
      {
        "id": "41a44afd-1051-4b22-8028-34828f327b7b",
        "emp_no": "E1006",
        "name": "刘洋",
        "dept": "研发中心",
        "title": "后端工程师",
        "level": "P5",
        "manager": "张伟",
        "join_date": "2024-02-19",
        "status": "active",
        "location": "苏州",
        "education": "本科 · 计算机科学",
        "tenure_months": 32,
        "skills": [
          {
            "name": "Java",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "分布式",
            "level": 2,
            "last_used_at": ""
          },
          {
            "name": "数据库",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "稳定性",
            "level": 2,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 68,
          "grade": "C",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 15,
              "hint": "基本信息完整"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 20,
              "hint": "已登记 4 项能力"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 10,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 8,
              "hint": "补充 2 条项目或绩效事实（含结果量化）"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 10,
              "hint": "有学习记录或进行中的培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 0,
              "hint": "把一条项目经验沉淀为知识卡片"
            }
          ],
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "把一条项目经验沉淀为知识卡片"
          ]
        },
        "facts": [
          {
            "id": "4080e218-e73d-407d-8394-b913b7e93033",
            "kind": "training",
            "kind_label": "学习记录",
            "title": "完成《分布式事务》课程",
            "summary": "情境：跨服务一致性理解不足。行动：完成 10 学时课程并输出笔记。结果：独立完成 2 个补偿方案评审。",
            "occurred_at": "2026-10-29",
            "tags": [
              "分布式"
            ],
            "evidence_strength": 1,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          },
          {
            "id": "8c5c661f-2259-46fc-b564-96d5b96bed59",
            "kind": "project",
            "kind_label": "项目经历",
            "title": "支付对账任务重构",
            "summary": "情境：对账任务经常超时。行动：批处理改分片 + 幂等补偿。结果：耗时从 42 分钟降到 9 分钟。",
            "occurred_at": "2026-10-14",
            "tags": [
              "数据库",
              "稳定性"
            ],
            "evidence_strength": 1,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [],
        "plans": [
          {
            "id": "aa322147-4434-400c-81af-d44cf5f7d5df",
            "target_role": "高级后端工程师",
            "status": "active",
            "created_at": "2026-10-29T09:56:05.014Z"
          }
        ],
        "twin": null
      },
      {
        "id": "a5c044df-2b9a-4dc2-bbac-f4aaec661a11",
        "emp_no": "E1007",
        "name": "孙悦",
        "dept": "市场部",
        "title": "市场经理",
        "level": "P6",
        "manager": "吴静",
        "join_date": "2022-04-01",
        "status": "active",
        "location": "上海",
        "education": "本科 · 传播学",
        "tenure_months": 55,
        "skills": [
          {
            "name": "品牌传播",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "活动策划",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "数据分析",
            "level": 2,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 58,
          "grade": "C",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 15,
              "hint": "基本信息完整"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 20,
              "hint": "已登记 3 项能力"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 10,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 8,
              "hint": "补充 2 条项目或绩效事实（含结果量化）"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 0,
              "hint": "登记学习记录，或生成一份 90 天培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 0,
              "hint": "把一条项目经验沉淀为知识卡片"
            }
          ],
          "hints": [
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划",
            "把一条项目经验沉淀为知识卡片"
          ]
        },
        "facts": [
          {
            "id": "6c32089c-d635-405c-a5f5-e50979233f6b",
            "kind": "project",
            "kind_label": "项目经历",
            "title": "行业峰会整合营销",
            "summary": "情境：品牌声量下滑。行动：联合 3 家伙伴做内容矩阵。结果：线索量 +65%，单条线索成本下降 28%。",
            "occurred_at": "2026-08-30",
            "tags": [
              "品牌传播"
            ],
            "evidence_strength": 2,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [],
        "plans": [],
        "twin": null
      },
      {
        "id": "1d89b559-ea5d-49dc-bea8-d92cd7c793bc",
        "emp_no": "E1008",
        "name": "周杰",
        "dept": "研发中心",
        "title": "测试工程师",
        "level": "P5",
        "manager": "郑凯",
        "join_date": "2025-06-16",
        "status": "active",
        "location": "苏州",
        "education": "本科 · 软件工程",
        "tenure_months": 17,
        "skills": [
          {
            "name": "自动化测试",
            "level": 3,
            "last_used_at": ""
          },
          {
            "name": "质量体系",
            "level": 2,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 64,
          "grade": "C",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 15,
              "hint": "基本信息完整"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 14,
              "hint": "至少登记 3 项能力及熟练度（1-5 级）"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 10,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 0,
              "hint": "补充 2 条项目或绩效事实（含结果量化）"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 10,
              "hint": "有学习记录或进行中的培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 10,
              "hint": "已贡献可复用经验"
            }
          ],
          "hints": [
            "至少登记 3 项能力及熟练度（1-5 级）",
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）"
          ]
        },
        "facts": [
          {
            "id": "d0e136bd-9e46-4ec6-8241-30a237d98a1b",
            "kind": "training",
            "kind_label": "学习记录",
            "title": "自动化测试训练营",
            "summary": "情境：回归靠手工，版本节奏被卡。行动：完成 16 学时训练并落地 20 条用例。结果：回归时间从 2 天降到 4 小时。",
            "occurred_at": "2026-10-24",
            "tags": [
              "自动化测试"
            ],
            "evidence_strength": 1,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [
          {
            "id": "4f251ad0-b49b-4ad7-820f-b86626cb278d",
            "title": "自动化测试落地：先保回归，再谈覆盖率",
            "reuse_count": 0
          }
        ],
        "plans": [],
        "twin": null
      },
      {
        "id": "96d09e49-6cd9-4527-b817-5e8a5a9dd878",
        "emp_no": "E1009",
        "name": "吴静",
        "dept": "财务部",
        "title": "财务主管",
        "level": "P7",
        "manager": "",
        "join_date": "2018-08-01",
        "status": "active",
        "location": "苏州",
        "education": "硕士 · 会计学",
        "tenure_months": 99,
        "skills": [
          {
            "name": "成本控制",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "预算管理",
            "level": 4,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 32,
          "grade": "D",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 13,
              "hint": "补齐姓名/部门/岗位/职级/上级/入职日期"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 14,
              "hint": "至少登记 3 项能力及熟练度（1-5 级）"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 0,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 0,
              "hint": "补充 2 条项目或绩效事实（含结果量化）"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 0,
              "hint": "登记学习记录，或生成一份 90 天培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 0,
              "hint": "把一条项目经验沉淀为知识卡片"
            }
          ],
          "hints": [
            "补齐姓名/部门/岗位/职级/上级/入职日期",
            "至少登记 3 项能力及熟练度（1-5 级）",
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划",
            "把一条项目经验沉淀为知识卡片"
          ]
        },
        "facts": [],
        "knowledge": [],
        "plans": [],
        "twin": null
      },
      {
        "id": "fb18a808-3454-48e0-a8d4-a4ed109c8437",
        "emp_no": "E1010",
        "name": "郑凯",
        "dept": "研发中心",
        "title": "技术负责人",
        "level": "P8",
        "manager": "",
        "join_date": "2017-02-13",
        "status": "active",
        "location": "苏州",
        "education": "硕士 · 计算机科学",
        "tenure_months": 117,
        "skills": [
          {
            "name": "架构设计",
            "level": 5,
            "last_used_at": ""
          },
          {
            "name": "团队管理",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "Java",
            "level": 4,
            "last_used_at": ""
          },
          {
            "name": "稳定性",
            "level": 4,
            "last_used_at": ""
          }
        ],
        "completeness": {
          "score": 56,
          "grade": "C",
          "items": [
            {
              "key": "base",
              "label": "基本信息",
              "max": 15,
              "points": 13,
              "hint": "补齐姓名/部门/岗位/职级/上级/入职日期"
            },
            {
              "key": "edu",
              "label": "教育与发展背景",
              "max": 5,
              "points": 5,
              "hint": "已登记教育背景"
            },
            {
              "key": "skills",
              "label": "能力标签",
              "max": 20,
              "points": 20,
              "hint": "已登记 4 项能力"
            },
            {
              "key": "facts",
              "label": "事实证据",
              "max": 25,
              "points": 10,
              "hint": "核实事实证据（项目/绩效/培训/反馈）至少 5 条"
            },
            {
              "key": "project",
              "label": "项目与绩效",
              "max": 15,
              "points": 8,
              "hint": "补充 2 条项目或绩效事实（含结果量化）"
            },
            {
              "key": "learning",
              "label": "学习与成长",
              "max": 10,
              "points": 0,
              "hint": "登记学习记录，或生成一份 90 天培养计划"
            },
            {
              "key": "knowledge",
              "label": "经验贡献",
              "max": 10,
              "points": 0,
              "hint": "把一条项目经验沉淀为知识卡片"
            }
          ],
          "hints": [
            "补齐姓名/部门/岗位/职级/上级/入职日期",
            "核实事实证据（项目/绩效/培训/反馈）至少 5 条",
            "补充 2 条项目或绩效事实（含结果量化）",
            "登记学习记录，或生成一份 90 天培养计划",
            "把一条项目经验沉淀为知识卡片"
          ]
        },
        "facts": [
          {
            "id": "79a5753e-8135-41b6-8ce2-a0d45e117708",
            "kind": "performance",
            "kind_label": "绩效结果",
            "title": "研发效能体系",
            "summary": "情境：交付周期不可度量。行动：建立需求到上线的度量看板。结果：平均交付周期从 21 天降到 13 天。",
            "occurred_at": "2026-07-31",
            "tags": [
              "团队管理",
              "稳定性"
            ],
            "evidence_strength": 3,
            "status": "verified",
            "verified_by": "zhaomin",
            "stale": false
          }
        ],
        "knowledge": [],
        "plans": [],
        "twin": null
      }
    ]
  },
  "GET /api/hr/twins": {
    "twins": [
      {
        "id": "3a3589d6-c3ff-430a-bfa1-f227961509b7",
        "employee_id": "00cf1602-6f98-4821-bec4-b9b2d3558e0d",
        "employee_name": "张伟",
        "dept": "研发中心",
        "title": "高级后端工程师",
        "status": "active",
        "level": "L1",
        "scope": {
          "topics": [
            "岗位职责",
            "项目经历",
            "技能与专长",
            "协作方式",
            "可提供的帮助"
          ],
          "denied": [
            "薪酬与奖金",
            "绩效评级细节",
            "他人评价",
            "离职或求职意向",
            "健康与婚育",
            "法律与医疗建议",
            "公司未公开信息"
          ],
          "data_policy": {
            "salary": false,
            "performance": "summary_only",
            "others_evaluation": false,
            "personal": false
          }
        },
        "authorized_by": "zhangwei",
        "authorized_at": "2026-10-19T09:56:05.058Z",
        "expires_at": "2027-04-17T09:56:05.058Z",
        "interaction_count": 8,
        "readiness": {
          "ready": true,
          "score": 100,
          "blockers": [],
          "checks": [
            {
              "key": "auth",
              "label": "本人授权有效",
              "ok": true,
              "detail": "授权在有效期内"
            },
            {
              "key": "data",
              "label": "数据覆盖度 ≥ 60",
              "ok": true,
              "detail": "当前 90 分（A 级）"
            },
            {
              "key": "evidence",
              "label": "已核实事实 ≥ 3 条",
              "ok": true,
              "detail": "当前 5 条"
            },
            {
              "key": "boundary",
              "label": "边界与数据策略已声明",
              "ok": true,
              "detail": "已声明拒答主题"
            }
          ]
        },
        "facts_count": 5,
        "knowledge_count": 1,
        "memory_preview": {
          "skills": [
            {
              "name": "Java",
              "level": 4,
              "last_used_at": ""
            },
            {
              "name": "分布式",
              "level": 4,
              "last_used_at": ""
            },
            {
              "name": "数据库",
              "level": 4,
              "last_used_at": ""
            },
            {
              "name": "稳定性",
              "level": 3,
              "last_used_at": ""
            },
            {
              "name": "代码评审",
              "level": 4,
              "last_used_at": ""
            },
            {
              "name": "灰度发布",
              "level": 4,
              "last_used_at": ""
            }
          ],
          "recent_facts": [
            {
              "id": "28afa0a4-3547-4a1c-a489-4ea3622280ce",
              "title": "订单中心灰度发布体系落地",
              "at": "2026-10-09"
            },
            {
              "id": "3d477737-ae03-450b-95cd-393cf32f024f",
              "title": "跨部门协作反馈",
              "at": "2026-10-19"
            },
            {
              "id": "b2286210-7482-4afe-a4db-cad100985d21",
              "title": "冒烟测试事实",
              "at": "2026-11-18"
            }
          ],
          "stale_warning": 0
        }
      },
      {
        "id": "5923c1b4-6f08-4886-9d38-170f2da2f6dc",
        "employee_id": "e8ddcf78-60d8-4e92-89c2-2e3bf4eabe00",
        "employee_name": "王芳",
        "dept": "产品部",
        "title": "产品经理",
        "status": "active",
        "level": "L1",
        "scope": {
          "topics": [
            "岗位职责",
            "项目经历",
            "技能与专长",
            "协作方式",
            "可提供的帮助"
          ],
          "denied": [
            "薪酬与奖金",
            "绩效评级细节",
            "他人评价",
            "离职或求职意向",
            "健康与婚育",
            "法律与医疗建议",
            "公司未公开信息"
          ],
          "data_policy": {
            "salary": false,
            "performance": "summary_only",
            "others_evaluation": false,
            "personal": false
          }
        },
        "authorized_by": "wangfang",
        "authorized_at": "2026-11-06T09:56:05.060Z",
        "expires_at": "2027-05-05T09:56:05.060Z",
        "interaction_count": 3,
        "readiness": {
          "ready": false,
          "score": 75,
          "blockers": [
            "当前 2 条"
          ],
          "checks": [
            {
              "key": "auth",
              "label": "本人授权有效",
              "ok": true,
              "detail": "授权在有效期内"
            },
            {
              "key": "data",
              "label": "数据覆盖度 ≥ 60",
              "ok": true,
              "detail": "当前 65 分（C 级）"
            },
            {
              "key": "evidence",
              "label": "已核实事实 ≥ 3 条",
              "ok": false,
              "detail": "当前 2 条"
            },
            {
              "key": "boundary",
              "label": "边界与数据策略已声明",
              "ok": true,
              "detail": "已声明拒答主题"
            }
          ]
        },
        "facts_count": 2,
        "knowledge_count": 0,
        "memory_preview": {
          "skills": [
            {
              "name": "需求分析",
              "level": 4,
              "last_used_at": ""
            },
            {
              "name": "数据分析",
              "level": 3,
              "last_used_at": ""
            },
            {
              "name": "项目管理",
              "level": 3,
              "last_used_at": ""
            },
            {
              "name": "用户研究",
              "level": 4,
              "last_used_at": ""
            }
          ],
          "recent_facts": [
            {
              "id": "023f7ea0-448d-4a92-9796-346e4abb7469",
              "title": "2025 年度绩效 A",
              "at": "2026-07-21"
            },
            {
              "id": "b199f173-e61f-4fd4-b0f3-9477e9ef7cc8",
              "title": "会员增长项目",
              "at": "2026-08-20"
            }
          ],
          "stale_warning": 0
        }
      },
      {
        "id": "90c3e07a-09fb-49a7-a021-d6ed3fad3840",
        "employee_id": "72c0b1b6-49c9-4f1d-bbe4-ca6d9f324d41",
        "employee_name": "陈晨",
        "dept": "产品部",
        "title": "高级产品经理",
        "status": "active",
        "level": "L1",
        "scope": {
          "topics": [
            "岗位职责",
            "项目经历",
            "技能与专长",
            "协作方式",
            "可提供的帮助",
            "成长与学习"
          ],
          "denied": [
            "薪酬与奖金",
            "绩效评级细节",
            "他人评价",
            "离职或求职意向",
            "健康与婚育",
            "法律与医疗建议",
            "公司未公开信息"
          ],
          "data_policy": {
            "salary": false,
            "performance": "summary_only",
            "others_evaluation": false,
            "personal": false
          }
        },
        "authorized_by": "admin",
        "authorized_at": "2026-11-18T10:24:29.226Z",
        "expires_at": "2027-02-16T10:24:29.219Z",
        "interaction_count": 0,
        "readiness": {
          "ready": false,
          "score": 50,
          "blockers": [
            "当前 58 分（C 级）",
            "当前 1 条"
          ],
          "checks": [
            {
              "key": "auth",
              "label": "本人授权有效",
              "ok": true,
              "detail": "授权在有效期内"
            },
            {
              "key": "data",
              "label": "数据覆盖度 ≥ 60",
              "ok": false,
              "detail": "当前 58 分（C 级）"
            },
            {
              "key": "evidence",
              "label": "已核实事实 ≥ 3 条",
              "ok": false,
              "detail": "当前 1 条"
            },
            {
              "key": "boundary",
              "label": "边界与数据策略已声明",
              "ok": true,
              "detail": "已声明拒答主题"
            }
          ]
        },
        "facts_count": 1,
        "knowledge_count": 0,
        "memory_preview": {
          "skills": [
            {
              "name": "需求分析",
              "level": 4,
              "last_used_at": ""
            },
            {
              "name": "数据分析",
              "level": 2,
              "last_used_at": ""
            },
            {
              "name": "项目管理",
              "level": 4,
              "last_used_at": ""
            },
            {
              "name": "用户研究",
              "level": 3,
              "last_used_at": ""
            }
          ],
          "recent_facts": [
            {
              "id": "6896e7ac-ff87-4142-a992-730e93500ec6",
              "title": "B 端工作台改版",
              "at": "2026-08-10"
            }
          ],
          "stale_warning": 0
        }
      }
    ],
    "metrics": {
      "twins_total": 3,
      "twins_active": 3,
      "twins_ready": 1,
      "queries_total": 8,
      "answered": 4,
      "refused": 3,
      "insufficient": 1,
      "answer_rate": 50,
      "refusal_topics": [
        {
          "topic": "绩效评级细节",
          "count": 1
        },
        {
          "topic": "离职或求职意向",
          "count": 1
        },
        {
          "topic": "薪酬与奖金",
          "count": 1
        }
      ],
      "avg_citations": 1.3,
      "coverage_gap": [
        {
          "employee": "王芳",
          "question": "她带过几个实习生？",
          "at": "2026-11-17T09:56:05.071Z"
        }
      ],
      "last_queries": [
        {
          "question": "他今年绩效多少，工资是多少？",
          "refused": true,
          "insufficient": false,
          "refused_topic": "薪酬与奖金",
          "confidence": 0,
          "asked_by": "admin",
          "created_at": "2026-11-18T10:26:35.139Z",
          "employee": "张伟"
        },
        {
          "question": "他负责过哪些稳定性项目？",
          "refused": false,
          "insufficient": false,
          "refused_topic": "",
          "confidence": 58,
          "asked_by": "admin",
          "created_at": "2026-11-18T10:26:35.098Z",
          "employee": "张伟"
        },
        {
          "question": "她带过几个实习生？",
          "refused": false,
          "insufficient": true,
          "refused_topic": "",
          "confidence": 0,
          "asked_by": "zhaomin",
          "created_at": "2026-11-17T09:56:05.071Z",
          "employee": "王芳"
        },
        {
          "question": "他打算什么时候离职？",
          "refused": true,
          "insufficient": false,
          "refused_topic": "离职或求职意向",
          "confidence": 0,
          "asked_by": "zhaomin",
          "created_at": "2026-11-16T09:56:05.068Z",
          "employee": "张伟"
        },
        {
          "question": "张伟的绩效评级是多少？",
          "refused": true,
          "insufficient": false,
          "refused_topic": "绩效评级细节",
          "confidence": 0,
          "asked_by": "zhaomin",
          "created_at": "2026-11-15T09:56:05.067Z",
          "employee": "张伟"
        },
        {
          "question": "灰度发布一般怎么分档？",
          "refused": false,
          "insufficient": false,
          "refused_topic": "",
          "confidence": 82,
          "asked_by": "zhaomin",
          "created_at": "2026-11-14T09:56:05.065Z",
          "employee": "张伟"
        },
        {
          "question": "王芳对新客留存的关键动作是什么？",
          "refused": false,
          "insufficient": false,
          "refused_topic": "",
          "confidence": 78,
          "asked_by": "zhaomin",
          "created_at": "2026-11-13T09:56:05.070Z",
          "employee": "王芳"
        },
        {
          "question": "张伟负责过哪些和稳定性相关的项目？",
          "refused": false,
          "insufficient": false,
          "refused_topic": "",
          "confidence": 86,
          "asked_by": "zhaomin",
          "created_at": "2026-11-12T09:56:05.062Z",
          "employee": "张伟"
        }
      ],
      "hours_saved": 0.8
    }
  },
  "GET /api/hr/learning/plans": {
    "plans": [
      {
        "id": "565eef21-1402-48d3-9a87-6d205d25aa69",
        "employee_id": "e8ddcf78-60d8-4e92-89c2-2e3bf4eabe00",
        "employee_name": "王芳",
        "target_role": "产品经理",
        "status": "active",
        "created_at": "2026-11-18T10:26:27.022Z",
        "started_at": "2026-11-18T10:26:27.022Z",
        "gaps": [
          {
            "skill": "数据分析",
            "current": 3,
            "required": 4,
            "gap": 1,
            "weight": 1.2,
            "priority": 1.2,
            "evidence_hint": "补齐一条「数据分析」的能力实证或项目记录"
          }
        ],
        "actions": [
          {
            "id": "A01",
            "phase": "0-30 天",
            "type": "reading",
            "title": "数据分析 专题阅读 + 输出笔记",
            "hours": 5,
            "due_days": 30,
            "gap_skill": "数据分析",
            "done": false
          },
          {
            "id": "A02",
            "phase": "31-60 天",
            "type": "project",
            "title": "在真实项目中承担 数据分析 相关任务并留证",
            "hours": 16,
            "due_days": 60,
            "gap_skill": "数据分析",
            "done": false
          },
          {
            "id": "A03",
            "phase": "61-90 天",
            "type": "knowledge",
            "title": "把本轮提升沉淀为一条可复用经验（含情境/行动/结果）",
            "hours": 4,
            "due_days": 90,
            "gap_skill": "数据分析",
            "done": false
          }
        ],
        "hours_planned": 25,
        "hours_done": 0,
        "completion": 0,
        "events": []
      },
      {
        "id": "aa322147-4434-400c-81af-d44cf5f7d5df",
        "employee_id": "41a44afd-1051-4b22-8028-34828f327b7b",
        "employee_name": "刘洋",
        "target_role": "高级后端工程师",
        "status": "active",
        "created_at": "2026-10-29T09:56:05.014Z",
        "started_at": "2026-10-29T09:56:05.014Z",
        "gaps": [
          {
            "skill": "分布式",
            "current": 2,
            "required": 4,
            "gap": 2,
            "weight": 1.2,
            "priority": 2.4
          },
          {
            "skill": "稳定性",
            "current": 2,
            "required": 4,
            "gap": 2,
            "weight": 1.1,
            "priority": 2.2
          }
        ],
        "actions": [
          {
            "id": "A01",
            "phase": "0-30 天",
            "type": "course",
            "title": "分布式事务系统课（从 2 级到 3 级）",
            "hours": 10,
            "due_days": 30,
            "gap_skill": "分布式",
            "done": true
          },
          {
            "id": "A02",
            "phase": "31-60 天",
            "type": "mentor",
            "title": "分布式导师带练（每周 1 次复盘）",
            "hours": 8,
            "due_days": 60,
            "gap_skill": "分布式",
            "done": true
          },
          {
            "id": "A03",
            "phase": "31-60 天",
            "type": "project",
            "title": "在真实项目中承担分布式补偿方案设计并留证",
            "hours": 16,
            "due_days": 60,
            "gap_skill": "稳定性",
            "done": false
          },
          {
            "id": "A04",
            "phase": "61-90 天",
            "type": "knowledge",
            "title": "沉淀《分布式事务实战要点》知识卡片",
            "hours": 4,
            "due_days": 90,
            "gap_skill": "稳定性",
            "done": false
          }
        ],
        "hours_planned": 38,
        "hours_done": 14,
        "completion": 50,
        "events": [
          {
            "action_id": "A01",
            "hours": 10,
            "score": 88,
            "kirkpatrick": 2,
            "at": "2026-11-06T09:56:05.017Z"
          },
          {
            "action_id": "A02",
            "hours": 4,
            "score": 0,
            "kirkpatrick": 3,
            "at": "2026-11-13T09:56:05.019Z"
          }
        ]
      }
    ],
    "effect": {
      "plans_total": 2,
      "plans_active": 2,
      "plans_done": 0,
      "completion_rate": 29,
      "hours_total": 16,
      "cost_total": 3520,
      "kirkpatrick": [
        {
          "level": 1,
          "name": "反应",
          "desc": "学员反馈与完成度",
          "count": 0
        },
        {
          "level": 2,
          "name": "学习",
          "desc": "测评分数与认证",
          "count": 1
        },
        {
          "level": 3,
          "name": "行为",
          "desc": "回到岗位后的行为变化（主管确认）",
          "count": 2
        },
        {
          "level": 4,
          "name": "结果",
          "desc": "对业务指标的影响（项目交付、缺陷率等）",
          "count": 0
        }
      ],
      "behavior_rate": 67,
      "uplift_count": 0,
      "uplift": [],
      "roi_note": "投入约 16 小时（¥3,520），当前可验证的能力提升 0 项；建议把未产生行为改变（柯氏 3 级）的课程下架。",
      "fallback": false
    }
  },
  "GET /api/hr/knowledge": {
    "items": [
      {
        "id": "4f251ad0-b49b-4ad7-820f-b86626cb278d",
        "title": "自动化测试落地：先保回归，再谈覆盖率",
        "domain": "质量",
        "status": "published",
        "version": 1,
        "situation": "回归靠手工，版本节奏被卡。",
        "action": "先挑 20 条高频回归用例自动化，接入每次提测。",
        "result": "回归 2 天 → 4 小时。",
        "reusable_rules": [
          "先自动化高频路径，不要追覆盖率数字"
        ],
        "tags": [
          "自动化测试"
        ],
        "source_employee_id": "1d89b559-ea5d-49dc-bea8-d92cd7c793bc",
        "source_fact_ids": [],
        "reuse_count": 0,
        "adopted_count": 0,
        "adoption_rate": 0,
        "ai_generated": false,
        "published_at": "2026-11-18T10:26:27.070Z",
        "created_at": "2026-11-08T09:56:05.038Z"
      },
      {
        "id": "0437481d-043e-4ab6-b9f4-0ac3ee86f334",
        "title": "灰度发布：2 条实践提炼出的可复用做法",
        "domain": "灰度发布",
        "status": "draft",
        "version": 0,
        "situation": "1. 输出《灰度发布检查清单》：团队新人重复踩发布坑。行动：把 12 次发布事故整理成 15 项检查清单\n2. 订单中心灰度发布体系落地：大促前每次全量发布都靠回滚兜底。行动：设计按租户分流的灰度通道，接入自动化卡点与一键回滚",
        "action": "1. 把 12 次发布事故整理成 15 项检查清单。结果：被 4 个小组采用，新人独立发布周期从 3 周降到 1 周\n2. 设计按租户分流的灰度通道，接入自动化卡点与一键回滚。结果：发布回滚率从 6% 降到 0.8%，大促期间零 P0",
        "result": "1. 被 4 个小组采用，新人独立发布周期从 3 周降到 1 周。\n2. 发布回滚率从 6% 降到 0.8%，大促期间零 P0。",
        "reusable_rules": [
          "遇到与「灰度发布」相关的场景，先按上表中的做法复现一遍，再决定改哪一步",
          "边界：只复用在同类场景；跨部门使用前先确认前提条件是否成立",
          "证据：本卡片由 2 条已核实事实支撑，引用时请一并标明来源员工与事实 id"
        ],
        "tags": [
          "灰度发布"
        ],
        "source_employee_id": "00cf1602-6f98-4821-bec4-b9b2d3558e0d",
        "source_fact_ids": [
          "4591fd0a-0413-4736-8e86-722a6e859b23",
          "28afa0a4-3547-4a1c-a489-4ea3622280ce"
        ],
        "reuse_count": 0,
        "adopted_count": 0,
        "adoption_rate": 0,
        "ai_generated": false,
        "published_at": "",
        "created_at": "2026-11-18T09:59:38.172Z"
      },
      {
        "id": "a93b5b2f-6a9e-4910-a544-4079c98be619",
        "title": "试用期不达标：把岗位能力模型接进面试评分表",
        "domain": "招聘",
        "status": "draft",
        "version": 0,
        "situation": "招聘标准与培养标准两张皮。",
        "action": "面试评分表直接引用岗位模型的 5 项能力，逐项打分并留证据。",
        "result": "试用期不达标率 15% → 7%。",
        "reusable_rules": [
          "评分表项必须与岗位模型同名",
          "每项至少一条证据，否则记 0"
        ],
        "tags": [
          "组织诊断",
          "招聘"
        ],
        "source_employee_id": "b9b2dc25-5bce-4fd2-910d-1c88dd1553ce",
        "source_fact_ids": [],
        "reuse_count": 0,
        "adopted_count": 0,
        "adoption_rate": 0,
        "ai_generated": false,
        "published_at": "",
        "created_at": "2026-10-29T09:56:05.036Z"
      },
      {
        "id": "68b7d041-040f-4203-8a77-c817e2964319",
        "title": "人才盘点：没有事实证据的九宫格都是印象派",
        "domain": "人才盘点",
        "status": "published",
        "version": 1,
        "situation": "晋升评审缺少证据，评委各凭印象。",
        "action": "九宫格每个格子必须挂 2 条已核实事实（项目/绩效/反馈），否则留空并标注待补。",
        "result": "盘点覆盖率 100%，争议复议下降一半。",
        "reusable_rules": [
          "先核实事实，再做排序",
          "同一事实不能被两个维度重复计分",
          "盘点结论必须回给本人，附缺失证据清单"
        ],
        "tags": [
          "人才盘点"
        ],
        "source_employee_id": "b9b2dc25-5bce-4fd2-910d-1c88dd1553ce",
        "source_fact_ids": [],
        "reuse_count": 4,
        "adopted_count": 2,
        "adoption_rate": 50,
        "ai_generated": false,
        "published_at": "2026-10-04T09:56:05.032Z",
        "created_at": "2026-10-04T09:56:05.032Z"
      },
      {
        "id": "036fb7ac-9b5c-44e8-a4f2-3959fc216692",
        "title": "灰度发布：先分租户再分比例，回滚必须一键",
        "domain": "稳定性",
        "status": "published",
        "version": 2,
        "situation": "大促前全量发布靠回滚兜底，一次 P0 事故损失约 2 小时交易。",
        "action": "按租户先切 1% → 5% → 20% → 50%，每一档看错误率与 P99；接自动化卡点，异常自动回滚。",
        "result": "回滚率 6% → 0.8%，大促零 P0。",
        "reusable_rules": [
          "发布前确认回滚脚本可用，且已在预发验证",
          "每档灰度至少观察 30 分钟，只看错误率与 P99 两个指标",
          "跨团队发布必须提前一天对齐窗口"
        ],
        "tags": [
          "灰度发布",
          "稳定性"
        ],
        "source_employee_id": "00cf1602-6f98-4821-bec4-b9b2d3558e0d",
        "source_fact_ids": [],
        "reuse_count": 4,
        "adopted_count": 3,
        "adoption_rate": 75,
        "ai_generated": false,
        "published_at": "2026-09-19T09:56:05.022Z",
        "created_at": "2026-09-19T09:56:05.022Z"
      },
      {
        "id": "419080a4-e6d7-4031-8702-38a11d7add97",
        "title": "首屏性能：先砍体积，再谈缓存",
        "domain": "性能",
        "status": "published",
        "version": 1,
        "situation": "交易页首屏 2.8s，转化率明显被拖累。",
        "action": "拆包 + 图片降级 + 预渲染，先做体积治理再考虑 CDN 与缓存策略。",
        "result": "首屏 1.4s，转化率 +3.1pp。",
        "reusable_rules": [
          "先量体积构成，再决定拆哪块，避免拍脑袋优化",
          "图片降级要按网络类型分档，不要一刀切",
          "优化前后用同一批真机与同一网络条件复测"
        ],
        "tags": [
          "性能优化"
        ],
        "source_employee_id": "5e241d85-7620-47b6-a251-953742095750",
        "source_fact_ids": [],
        "reuse_count": 2,
        "adopted_count": 1,
        "adoption_rate": 50,
        "ai_generated": false,
        "published_at": "2026-08-20T09:56:05.026Z",
        "created_at": "2026-08-20T09:56:05.026Z"
      }
    ],
    "health": {
      "total": 6,
      "published": 4,
      "drafts": 2,
      "usage_total": 10,
      "adopted_total": 6,
      "adoption_rate": 60,
      "coverage_domains": 4,
      "top": [
        {
          "id": "036fb7ac-9b5c-44e8-a4f2-3959fc216692",
          "title": "灰度发布：先分租户再分比例，回滚必须一键",
          "usage": 4,
          "adopted": 3,
          "adoption_rate": 75,
          "last_used": "2026-11-14T09:56:05.046Z",
          "dormant": false
        },
        {
          "id": "68b7d041-040f-4203-8a77-c817e2964319",
          "title": "人才盘点：没有事实证据的九宫格都是印象派",
          "usage": 4,
          "adopted": 2,
          "adoption_rate": 50,
          "last_used": "2026-11-18T10:26:27.104Z",
          "dormant": false
        },
        {
          "id": "419080a4-e6d7-4031-8702-38a11d7add97",
          "title": "首屏性能：先砍体积，再谈缓存",
          "usage": 2,
          "adopted": 1,
          "adoption_rate": 50,
          "last_used": "2026-11-10T09:56:05.050Z",
          "dormant": false
        },
        {
          "id": "4f251ad0-b49b-4ad7-820f-b86626cb278d",
          "title": "自动化测试落地：先保回归，再谈覆盖率",
          "usage": 0,
          "adopted": 0,
          "adoption_rate": 0,
          "last_used": "",
          "dormant": true
        }
      ],
      "dormant": [
        {
          "id": "4f251ad0-b49b-4ad7-820f-b86626cb278d",
          "title": "自动化测试落地：先保回归，再谈覆盖率",
          "usage": 0,
          "adopted": 0,
          "adoption_rate": 0,
          "last_used": "",
          "dormant": true
        }
      ],
      "suggestions": [
        {
          "kind": "promote",
          "title": "把「灰度发布：先分租户再分比例，回滚必须一键」提升为标准动作",
          "why": "已复用 4 次，采纳率 75%"
        },
        {
          "kind": "promote",
          "title": "把「人才盘点：没有事实证据的九宫格都是印象派」提升为标准动作",
          "why": "已复用 4 次，采纳率 50%"
        },
        {
          "kind": "archive",
          "title": "「自动化测试落地：先保回归，再谈覆盖率」90 天零引用",
          "why": "建议归档或改写成更具体的场景卡片"
        }
      ],
      "evolution_note": "自进化只做「建议 → 人确认 → 新版本」，不做自动改写知识正文；知识是企业的公共事实，不能由模型静默覆盖。"
    },
    "drafts_available": 0
  },
  "GET /api/hr/recruiting/efficiency": {
    "snapshot": {
      "at": "2026-11-17T09:56:05.081Z",
      "source": "recruitment.query.applications",
      "truncated": true,
      "applications_seen": 20,
      "applications_total": 41,
      "stage": {
        "screening": 9,
        "interview": 6,
        "offer": 3,
        "onboarding": 2
      },
      "outcome": {
        "hired": 2,
        "rejected": 8,
        "withdrawn": 2,
        "active": 8
      },
      "ai_screened": 13,
      "ai_screen_rate": 65,
      "open_jobs": 4,
      "jobs": [
        {
          "code": "JOB-2026-001",
          "title": "高级后端工程师",
          "dept": "研发中心",
          "status": "open"
        },
        {
          "code": "JOB-2026-002",
          "title": "前端工程师",
          "dept": "研发中心",
          "status": "open"
        },
        {
          "code": "JOB-2026-003",
          "title": "产品经理",
          "dept": "产品部",
          "status": "open"
        },
        {
          "code": "JOB-2026-004",
          "title": "HRBP",
          "dept": "人力资源部",
          "status": "open"
        }
      ]
    },
    "funnel": [
      {
        "key": "sourced",
        "label": "触达/投递",
        "value": 462
      },
      {
        "key": "screened",
        "label": "初筛通过",
        "value": 182
      },
      {
        "key": "interviewed",
        "label": "进入面试",
        "value": 96
      },
      {
        "key": "offers",
        "label": "发出 Offer",
        "value": 35
      },
      {
        "key": "hired",
        "label": "成功入职",
        "value": 29
      }
    ],
    "stages": [
      {
        "key": "sourced",
        "label": "触达/投递",
        "value": 462,
        "rate_from_prev": 100,
        "rate_from_top": 100
      },
      {
        "key": "screened",
        "label": "初筛通过",
        "value": 182,
        "rate_from_prev": 39,
        "rate_from_top": 39
      },
      {
        "key": "interviewed",
        "label": "进入面试",
        "value": 96,
        "rate_from_prev": 53,
        "rate_from_top": 21
      },
      {
        "key": "offers",
        "label": "发出 Offer",
        "value": 35,
        "rate_from_prev": 36,
        "rate_from_top": 8
      },
      {
        "key": "hired",
        "label": "成功入职",
        "value": 29,
        "rate_from_prev": 83,
        "rate_from_top": 6
      }
    ],
    "channels": [
      {
        "id": "02d8bf4e-9eaf-49e4-ac83-e6187996555c",
        "name": "员工内推",
        "type": "内部",
        "spend": 32000,
        "sourced": 42,
        "screened": 26,
        "interviewed": 16,
        "offers": 8,
        "hired": 7,
        "quality_hires": 6,
        "cpa": 4571,
        "screen_rate": 62,
        "interview_rate": 62,
        "offer_rate": 50,
        "accept_rate": 88,
        "quality_rate": 86,
        "cost_per_quality_hire": 5333,
        "internal_hours": 36,
        "status": "active"
      },
      {
        "id": "9dd04929-51f2-4730-8035-eaea2500c7a3",
        "name": "招聘网站 A",
        "type": "外部平台",
        "spend": 50000,
        "sourced": 210,
        "screened": 64,
        "interviewed": 28,
        "offers": 9,
        "hired": 7,
        "quality_hires": 3,
        "cpa": 7143,
        "screen_rate": 30,
        "interview_rate": 44,
        "offer_rate": 32,
        "accept_rate": 78,
        "quality_rate": 43,
        "cost_per_quality_hire": 16667,
        "internal_hours": 64,
        "status": "active"
      },
      {
        "id": "1bee9028-225b-4a4c-b2f2-ed7cbda17f1b",
        "name": "猎头合作",
        "type": "猎头",
        "spend": 90000,
        "sourced": 26,
        "screened": 18,
        "interviewed": 12,
        "offers": 4,
        "hired": 3,
        "quality_hires": 3,
        "cpa": 30000,
        "screen_rate": 69,
        "interview_rate": 67,
        "offer_rate": 33,
        "accept_rate": 75,
        "quality_rate": 100,
        "cost_per_quality_hire": 30000,
        "internal_hours": 18,
        "status": "active"
      },
      {
        "id": "664469ed-6828-4f8d-9491-4fe63cf25fab",
        "name": "校园招聘",
        "type": "校园",
        "spend": 32000,
        "sourced": 150,
        "screened": 58,
        "interviewed": 30,
        "offers": 10,
        "hired": 8,
        "quality_hires": 5,
        "cpa": 4000,
        "screen_rate": 39,
        "interview_rate": 52,
        "offer_rate": 33,
        "accept_rate": 80,
        "quality_rate": 63,
        "cost_per_quality_hire": 6400,
        "internal_hours": 52,
        "status": "active"
      },
      {
        "id": "244b3ff4-6d60-4405-bba7-5952a776c6e3",
        "name": "行业社群",
        "type": "社群",
        "spend": 12000,
        "sourced": 34,
        "screened": 16,
        "interviewed": 10,
        "offers": 4,
        "hired": 4,
        "quality_hires": 3,
        "cpa": 3000,
        "screen_rate": 47,
        "interview_rate": 63,
        "offer_rate": 40,
        "accept_rate": 100,
        "quality_rate": 75,
        "cost_per_quality_hire": 4000,
        "internal_hours": 12,
        "status": "active"
      }
    ],
    "totals": {
      "spend": 216000,
      "internal_hours": 182,
      "internal_cost": 40040,
      "total_cost": 256040,
      "hires": 29,
      "cost_per_hire": 8829,
      "ai_adjusted_cost_per_hire": 8788,
      "quality_rate": 69,
      "ai_hours_saved": 5.4,
      "ai_value_saved": 1188,
      "ai_screen_rate": 65,
      "avg_cpa": 7448,
      "offer_accept_rate": 83
    },
    "quality": {
      "best_channel": "猎头合作",
      "best_channel_rate": 100,
      "note": "质量口径：入职 90 天通过试用期/首评达标的人数 ÷ 入职人数。价格便宜的渠道，如果试用期流失高，真实成本会翻倍。"
    },
    "recommendations": [
      {
        "id": "7f1be3ea-c8a5-4b1f-8766-9e71ce6102a3",
        "kind": "budget_shift",
        "title": "把「猎头合作」的预算向高质量渠道迁移",
        "rationale": "猎头合作 的单人成本 ¥30000，是均值 ¥7448 的 4 倍，且 90 天质量率仅 100%。按同等入职量测算，迁移后可省约 ¥67656。",
        "evidence": {
          "channel": "猎头合作",
          "cpa": 30000,
          "avg_cpa": 7448,
          "quality_rate": 100,
          "spend": 90000,
          "hires": 3
        },
        "expected_saving": 67656,
        "status": "proposed",
        "baseline": {
          "cost_per_hire": 8829,
          "spend": 216000,
          "hires": 29,
          "at": "2026-11-18T09:59:38.211Z"
        },
        "measured": {},
        "created_at": "2026-11-18T09:59:38.211Z",
        "adopted_at": ""
      },
      {
        "id": "72e5ec96-b561-4f02-9cc2-ed4c3be86374",
        "kind": "budget_increase",
        "title": "给「员工内推」加投（质量最高但预算占比低）",
        "rationale": "员工内推 的 90 天质量率 86%、单人成本 ¥3429，但只占预算 11%。加投的边际成本低于在低质量渠道上重复获客。",
        "evidence": {
          "channel": "员工内推",
          "quality_rate": 86,
          "cpa": 3429,
          "spend_share": 11
        },
        "expected_saving": 0,
        "status": "proposed",
        "baseline": {
          "cost_per_hire": 8829,
          "spend": 216000,
          "hires": 29,
          "at": "2026-11-18T09:59:38.209Z"
        },
        "measured": {},
        "created_at": "2026-11-18T09:59:38.209Z",
        "adopted_at": ""
      },
      {
        "id": "88c3a3de-a2e0-4f79-a2f4-ee557d89ac81",
        "kind": "budget_shift",
        "title": "把「招聘网站 A」的预算向高质量渠道迁移",
        "rationale": "招聘网站 A 单人成本约 ¥10,000，是均值 ¥8,057 的 1.24 倍，且 90 天质量率仅 43%，明显低于内推的 86%。",
        "evidence": {
          "channel": "招聘网站 A",
          "cpa": 10000,
          "avg_cpa": 8057,
          "quality_rate": 43,
          "spend": 58000,
          "hires": 7
        },
        "expected_saving": 11000,
        "status": "measured",
        "baseline": {
          "cost_per_hire": 8829,
          "spend": 216000,
          "hires": 29,
          "at": "2026-11-18T10:26:49.644Z",
          "moved": {
            "from": "招聘网站 A",
            "to": "员工内推",
            "amount": 8000
          }
        },
        "measured": {
          "before_cost_per_hire": 8829,
          "after_cost_per_hire": 8829,
          "delta": 0,
          "delta_rate": 0,
          "before_hires": 29,
          "after_hires": 29,
          "note": "一个周期后回测",
          "at": "2026-11-18T10:26:49.691Z",
          "verdict": "暂无变化"
        },
        "created_at": "2026-11-11T09:56:05.083Z",
        "adopted_at": "2026-11-18T10:26:49.644Z"
      },
      {
        "id": "41af55c9-4ef0-4707-af15-83fa15de8249",
        "kind": "ai_screening",
        "title": "把 AI 预筛覆盖率从 65% 提到 90%",
        "rationale": "仍有 35% 的申请靠人工过简历；按每次初筛 25 分钟计，补齐后每批约省 5.8 小时。",
        "evidence": {
          "ai_screen_rate": 65,
          "applications": 20
        },
        "expected_saving": 1276,
        "status": "measured",
        "baseline": {
          "cost_per_hire": 8600,
          "spend": 216000,
          "hires": 16,
          "at": "2026-10-04T09:56:05.085Z"
        },
        "measured": {
          "before_cost_per_hire": 8600,
          "after_cost_per_hire": 8057,
          "delta": 543,
          "delta_rate": 6.3,
          "note": "按同口径重算，AI 抵扣后单个入职成本下降 6.3%",
          "at": "2026-11-15T09:56:05.085Z",
          "verdict": "达标"
        },
        "created_at": "2026-10-04T09:56:05.085Z",
        "adopted_at": "2026-10-04T09:56:05.085Z"
      }
    ],
    "benchmark_note": "行业参考：单次招聘成本受岗位类型影响极大（一线岗位数百元级、专业岗位数千元级、稀缺技术岗可达数万元），绝对值不跨岗位比较；本页只做同企业、同岗位族的相对比较。",
    "internal_matches": []
  },
  "GET /api/hr/autonomy": {
    "levels": [
      {
        "level": "L0",
        "name": "观察",
        "desc": "只读与看板。AI 可以算、可以展示，不产生任何业务动作。",
        "tone": "gray"
      },
      {
        "level": "L1",
        "name": "建议",
        "desc": "AI 产出建议与草稿，由人自己决定是否采纳、自己做执行。",
        "tone": "blue"
      },
      {
        "level": "L2",
        "name": "单步确认",
        "desc": "AI 准备一条写入，人在确认卡上核对后点一次确认，事务内落库并留审计。",
        "tone": "green"
      },
      {
        "level": "L3",
        "name": "计划确认",
        "desc": "AI 准备多步或批量方案（培养计划、预算调整），人确认整包后按计划执行。",
        "tone": "amber"
      },
      {
        "level": "L4",
        "name": "人主办",
        "desc": "AI 只做材料整理与检索，判断、沟通与执行必须由人完成。",
        "tone": "red"
      }
    ],
    "rows": [
      {
        "action_key": "hr.analytics.view",
        "name": "中台看板与指标",
        "default_level": "L0",
        "risk": "low",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [],
        "why": "只读聚合，不写业务事实",
        "escalate": "导出含个人敏感字段时升级到 L4 授权",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L0",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.asset.ledger",
        "name": "员工资产台账",
        "default_level": "L0",
        "risk": "low",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [],
        "why": "只读资产覆盖度与缺口",
        "escalate": "按人下钻到薪酬结构时升级",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L0",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.twin.answer",
        "name": "数字分身代答",
        "default_level": "L1",
        "risk": "low",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [
          "personal"
        ],
        "why": "限定在本人授权范围内，输出带证据引用",
        "escalate": "越出授权主题或涉及他人评价时直接 L4 拒答",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L1",
        "usage": 1,
        "last_level": "L3",
        "last_at": "2026-10-29T09:56:05.095Z"
      },
      {
        "action_key": "hr.knowledge.recommend",
        "name": "知识推荐",
        "default_level": "L1",
        "risk": "low",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [],
        "why": "只做检索与排序，不改知识内容",
        "escalate": "推荐结果被用作处分依据时升级",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L1",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.recruit.recommend",
        "name": "招聘降本建议",
        "default_level": "L1",
        "risk": "low",
        "reversible": true,
        "blast_radius": "team",
        "sensitivity": [],
        "why": "给建议与测算，不动预算",
        "escalate": "采纳并改预算时升 L3",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L1",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.learning.gap.propose",
        "name": "能力差距与培养计划草稿",
        "default_level": "L1",
        "risk": "low",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [
          "performance"
        ],
        "why": "基于能力模型算差距，草稿可改",
        "escalate": "计划与晋升/调薪挂钩时升 L4",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L1",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.employee.save",
        "name": "员工建档与字段更新",
        "default_level": "L2",
        "risk": "medium",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [
          "personal"
        ],
        "why": "影响一个人的人事事实，需人核对",
        "escalate": "改职级/汇报线/成本中心时升 L3",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L2",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.fact.record",
        "name": "登记员工事实",
        "default_level": "L2",
        "risk": "low",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [
          "performance"
        ],
        "why": "事实会进入画像与 AI 结论，必须人确认后才算数",
        "escalate": "批量导入或跨部门写入时升 L3",
        "policy_level": "L3",
        "policy_reason": "冒烟测试上调门槛",
        "effective_level": "L3",
        "usage": 1,
        "last_level": "L3",
        "last_at": "2026-10-19T09:56:05.091Z"
      },
      {
        "action_key": "hr.fact.verify",
        "name": "核实员工事实",
        "default_level": "L2",
        "risk": "medium",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [
          "performance"
        ],
        "why": "核实等于给证据背书，需责任人签字",
        "escalate": "涉及争议事实时升 L4",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L2",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.learning.event",
        "name": "记录学习完成",
        "default_level": "L2",
        "risk": "low",
        "reversible": true,
        "blast_radius": "self",
        "sensitivity": [],
        "why": "学习记录进入培养效果评估",
        "escalate": "与认证/资格挂钩时升 L3",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L2",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.knowledge.publish",
        "name": "发布知识卡片",
        "default_level": "L2",
        "risk": "low",
        "reversible": true,
        "blast_radius": "team",
        "sensitivity": [],
        "why": "影响团队做法，但有版本可回滚",
        "escalate": "涉及客户信息或对外口径时升 L3",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L2",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.interview.schedule",
        "name": "安排面试",
        "default_level": "L2",
        "risk": "low",
        "reversible": true,
        "blast_radius": "team",
        "sensitivity": [],
        "why": "占用面试官时间，需确认时间与轮次",
        "escalate": "自动改面试结论时升 L4",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L2",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.learning.plan.publish",
        "name": "发布培养计划",
        "default_level": "L3",
        "risk": "medium",
        "reversible": true,
        "blast_radius": "team",
        "sensitivity": [
          "performance"
        ],
        "why": "跨 90 天多步动作，承诺资源与时间",
        "escalate": "计划含晋升承诺时升 L4",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L3",
        "usage": 1,
        "last_level": "L3",
        "last_at": "2026-10-29T09:56:05.099Z"
      },
      {
        "action_key": "hr.recruit.budget.shift",
        "name": "招聘渠道预算调整",
        "default_level": "L3",
        "risk": "medium",
        "reversible": true,
        "blast_radius": "company",
        "sensitivity": [],
        "why": "直接花钱且影响公司整体获客",
        "escalate": "单次调整超过月预算 30% 时升 L4",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L3",
        "usage": 1,
        "last_level": "L3",
        "last_at": "2026-11-11T09:56:05.107Z"
      },
      {
        "action_key": "hr.recruit.batch.screen",
        "name": "批量筛选与批量淘汰",
        "default_level": "L3",
        "risk": "high",
        "reversible": false,
        "blast_radius": "company",
        "sensitivity": [
          "personal"
        ],
        "why": "一次影响多名候选人，且淘汰不可完全撤回",
        "escalate": "命中受保护属性或批量>20 人时升 L4",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L3",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.twin.authorize",
        "name": "数字分身授权",
        "default_level": "L4",
        "risk": "high",
        "reversible": false,
        "blast_radius": "self",
        "sensitivity": [
          "personal"
        ],
        "why": "个人数据边界的让渡，必须本人知情同意",
        "escalate": "授权范围含跨部门可见时需 HR 负责人共同签",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L4",
        "usage": 1,
        "last_level": "L4",
        "last_at": "2026-11-06T09:56:05.103Z"
      },
      {
        "action_key": "hr.offer.approve",
        "name": "录用与 Offer 决定",
        "default_level": "L4",
        "risk": "high",
        "reversible": false,
        "blast_radius": "team",
        "sensitivity": [
          "salary"
        ],
        "why": "涉及薪酬承诺与法律效力",
        "escalate": "超带宽 Offer 需加一级审批",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L4",
        "usage": 2,
        "last_level": "L4",
        "last_at": "2026-11-18T10:26:35.041Z"
      },
      {
        "action_key": "hr.comp.change",
        "name": "调薪与奖金分配",
        "default_level": "L4",
        "risk": "high",
        "reversible": false,
        "blast_radius": "team",
        "sensitivity": [
          "salary"
        ],
        "why": "直接改变个人收入与团队公平",
        "escalate": "一律人主办，AI 只做测算与材料",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L4",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.performance.rating",
        "name": "绩效评级",
        "default_level": "L4",
        "risk": "high",
        "reversible": false,
        "blast_radius": "team",
        "sensitivity": [
          "performance"
        ],
        "why": "评级影响晋升、调薪与去留",
        "escalate": "AI 不得给出评级结论，仅整理证据",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L4",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.exit.process",
        "name": "离职与解除处理",
        "default_level": "L4",
        "risk": "high",
        "reversible": false,
        "blast_radius": "self",
        "sensitivity": [
          "personal"
        ],
        "why": "法律与情绪风险都高",
        "escalate": "一律人主办",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L4",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      },
      {
        "action_key": "hr.discipline",
        "name": "纪律与投诉调查",
        "default_level": "L4",
        "risk": "high",
        "reversible": false,
        "blast_radius": "team",
        "sensitivity": [
          "personal"
        ],
        "why": "涉及事实认定与程序正义",
        "escalate": "一律人主办",
        "policy_level": "",
        "policy_reason": "",
        "effective_level": "L4",
        "usage": 0,
        "last_level": "",
        "last_at": ""
      }
    ],
    "usage": {
      "L0": 0,
      "L1": 0,
      "L2": 0,
      "L3": 4,
      "L4": 3
    },
    "decisions_total": 7,
    "recent_decisions": [
      {
        "id": "d3294a30-3171-4fa3-b2f1-ec79c24d0559",
        "action_key": "hr.offer.approve",
        "action_name": "录用与 Offer 决定",
        "level": "L4",
        "reasons": [
          "基线：录用与 Offer 决定默认 L4 级",
          "高风险动作：至少 L3（计划确认）",
          "不可逆动作：至少 L3",
          "影响面为团队级：至少 L2",
          "AI 置信度 93%，未触发上调"
        ],
        "actor": "admin",
        "created_at": "2026-11-18T10:26:35.041Z",
        "subject": "测试"
      },
      {
        "id": "97d7a435-c521-4285-8d86-05a1e01975b9",
        "action_key": "hr.offer.approve",
        "action_name": "录用与 Offer 决定",
        "level": "L4",
        "reasons": [
          "基线：录用与 Offer 决定默认 L4 级",
          "高风险动作：至少 L3（计划确认）",
          "不可逆动作：至少 L3",
          "影响面为团队级：至少 L2"
        ],
        "actor": "zhaomin",
        "created_at": "2026-11-14T09:56:05.114Z",
        "subject": "高级后端 Offer 审批"
      },
      {
        "id": "2873f786-a4a8-4c69-a57b-d997d88a3518",
        "action_key": "hr.recruit.budget.shift",
        "action_name": "招聘渠道预算调整",
        "level": "L3",
        "reasons": [
          "基线：招聘渠道预算调整默认 L3 级",
          "中风险动作：至少 L2（单步确认）",
          "影响面为公司级：至少 L3"
        ],
        "actor": "zhaomin",
        "created_at": "2026-11-11T09:56:05.107Z",
        "subject": "渠道预算调整"
      },
      {
        "id": "ae2db842-f611-47cd-b34e-6533ce199323",
        "action_key": "hr.twin.authorize",
        "action_name": "数字分身授权",
        "level": "L4",
        "reasons": [
          "基线：数字分身授权默认 L4 级",
          "高风险动作：至少 L3（计划确认）",
          "不可逆动作：至少 L3"
        ],
        "actor": "zhaomin",
        "created_at": "2026-11-06T09:56:05.103Z",
        "subject": "王芳分身授权"
      },
      {
        "id": "fbd7de68-9684-428b-a835-4cb53fe65cbc",
        "action_key": "hr.learning.plan.publish",
        "action_name": "发布培养计划",
        "level": "L3",
        "reasons": [
          "基线：发布培养计划默认 L3 级",
          "中风险动作：至少 L2（单步确认）",
          "影响面为团队级：至少 L2"
        ],
        "actor": "zhaomin",
        "created_at": "2026-10-29T09:56:05.099Z",
        "subject": "刘洋 90 天计划"
      },
      {
        "id": "9e8e01b7-cb4e-4046-b3e9-c7bd31c4158b",
        "action_key": "hr.twin.answer",
        "action_name": "数字分身代答",
        "level": "L3",
        "reasons": [
          "基线：数字分身代答默认 L1 级",
          "命中敏感数据（personal），强制抬到 L3",
          "AI 置信度 90%，未触发上调"
        ],
        "actor": "zhaomin",
        "created_at": "2026-10-29T09:56:05.095Z",
        "subject": "王芳分身穿答"
      },
      {
        "id": "73df3279-c7ea-418d-84b0-62bf7a1c3ef7",
        "action_key": "hr.fact.record",
        "action_name": "登记员工事实",
        "level": "L3",
        "reasons": [
          "基线：登记员工事实默认 L2 级",
          "命中敏感数据（performance），强制抬到 L3"
        ],
        "actor": "zhaomin",
        "created_at": "2026-10-19T09:56:05.091Z",
        "subject": "张伟项目事实登记"
      }
    ]
  },
  "GET /api/invoices": [],
  "POST /api/chat/context": {
    "ok": true,
    "applied": true
  }
};
window.__DEMO_META__ = { snapshot: '2026-11-18', source: 'sukesong 2.0 · shangshu-server /api/hr', note: '静态快照，写操作只演示交互，不修改数据' };
