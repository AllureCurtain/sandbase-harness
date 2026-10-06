export const pages = {
  agents: {
    title: "Agents",
    description: "Reusable agent definitions: model, tools, skills, environment and budget.",
    newAgent: "New agent",
  },
  sessions: {
    title: "Sessions",
    description: "Every session the runtime has run or is running.",
    newSession: "New session",
  },
  environments: {
    title: "Environments",
    description: "Configuration templates for session sandboxes.",
    newEnvironment: "New environment",
  },
  "credential-vaults": {
    title: "Credential vaults",
    description: "Encrypted credentials injected into agent environments.",
    newVault: "New vault",
  },
  "memory-stores": {
    title: "Memory stores",
    description: "Persistent memory available to sessions.",
    newStore: "New store",
  },
  files: {
    title: "Files",
    description: "Workspace files visible to sessions.",
  },
  skills: {
    title: "Skills",
    description: "Skill packages attachable to agents.",
    newSkill: "New skill",
  },
  webhooks: {
    title: "Webhooks",
    description: "HTTP endpoints that trigger agent work.",
    newWebhook: "New webhook",
  },
  "scheduled-deployments": {
    title: "Scheduled deployments",
    description: "Deployments that start sessions on a schedule.",
    newDeployment: "New schedule",
  },
  outcomes: {
    title: "Outcome templates",
    description: "Local templates for recording session outcomes.",
    newTemplate: "New template",
  },
  settings: {
    title: "Settings",
    description: "Runtime configuration and capabilities.",
  },
} as const;
