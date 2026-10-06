import { agents as enAgents } from './locales/en/agents';
import { common as enCommon } from './locales/en/common';
import { credentials as enCredentials } from './locales/en/credentials';
import { environments as enEnvironments } from './locales/en/environments';
import { files as enFiles } from './locales/en/files';
import { memory as enMemory } from './locales/en/memory';
import { operations as enOperations } from './locales/en/operations';
import { navigation as enNavigation } from './locales/en/navigation';
import { pages as enPages } from './locales/en/pages';
import { sessions as enSessions } from './locales/en/sessions';
import { settings as enSettings } from './locales/en/settings';
import { skills as enSkills } from './locales/en/skills';
import { agents as zhCNAgents } from './locales/zh-CN/agents';
import { common as zhCNCommon } from './locales/zh-CN/common';
import { credentials as zhCNCredentials } from './locales/zh-CN/credentials';
import { environments as zhCNEnvironments } from './locales/zh-CN/environments';
import { files as zhCNFiles } from './locales/zh-CN/files';
import { memory as zhCNMemory } from './locales/zh-CN/memory';
import { operations as zhCNOperations } from './locales/zh-CN/operations';
import { navigation as zhCNNavigation } from './locales/zh-CN/navigation';
import { pages as zhCNPages } from './locales/zh-CN/pages';
import { sessions as zhCNSessions } from './locales/zh-CN/sessions';
import { settings as zhCNSettings } from './locales/zh-CN/settings';
import { skills as zhCNSkills } from './locales/zh-CN/skills';

export const defaultNamespace = 'common';

export const resources = {
  en: {
    agents: enAgents,
    common: enCommon,
    credentials: enCredentials,
    environments: enEnvironments,
    files: enFiles,
    memory: enMemory,
    operations: enOperations,
    navigation: enNavigation,
    pages: enPages,
    sessions: enSessions,
    settings: enSettings,
    skills: enSkills,
  },
  'zh-CN': {
    agents: zhCNAgents,
    common: zhCNCommon,
    credentials: zhCNCredentials,
    environments: zhCNEnvironments,
    files: zhCNFiles,
    memory: zhCNMemory,
    operations: zhCNOperations,
    navigation: zhCNNavigation,
    pages: zhCNPages,
    sessions: zhCNSessions,
    settings: zhCNSettings,
    skills: zhCNSkills,
  },
} as const;
