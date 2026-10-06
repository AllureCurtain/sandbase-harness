export const pages = {
  agents: {
    title: "Agents",
    description: "可复用的 agent 定义：模型、工具、技能、环境和预算。",
    newAgent: "新建 agent",
  },
  sessions: {
    title: "会话",
    description: "运行时已运行或正在运行的全部会话。",
    newSession: "新建会话",
  },
  environments: {
    title: "环境",
    description: "会话沙箱的配置模板。",
    newEnvironment: "新建环境",
  },
  "credential-vaults": {
    title: "凭据保险库",
    description: "注入 agent 环境的加密凭据。",
    newVault: "新建保险库",
  },
  "memory-stores": {
    title: "记忆存储",
    description: "会话可用的持久化记忆。",
    newStore: "新建存储",
  },
  files: {
    title: "文件",
    description: "会话可见的工作区文件。",
  },
  skills: {
    title: "技能",
    description: "可挂载到 agent 的技能包。",
    newSkill: "新建技能",
  },
  webhooks: {
    title: "Webhooks",
    description: "触发 agent 工作的 HTTP 端点。",
    newWebhook: "新建 webhook",
  },
  "scheduled-deployments": {
    title: "定时部署",
    description: "按计划启动会话的部署。",
    newDeployment: "新建计划",
  },
  outcomes: {
    title: "结果模板",
    description: "记录会话结果的本地模板。",
    newTemplate: "新建模板",
  },
  settings: {
    title: "设置",
    description: "运行时配置与能力。",
  },
} as const;
