import { agents as enAgents } from './locales/en/agents';
import { common as enCommon } from './locales/en/common';
import { credentials as enCredentials } from './locales/en/credentials';
import { environments as enEnvironments } from './locales/en/environments';
import { memory as enMemory } from './locales/en/memory';
import { navigation as enNavigation } from './locales/en/navigation';
import { pages as enPages } from './locales/en/pages';
import { sessions as enSessions } from './locales/en/sessions';
import { agents as zhCNAgents } from './locales/zh-CN/agents';
import { common as zhCNCommon } from './locales/zh-CN/common';
import { credentials as zhCNCredentials } from './locales/zh-CN/credentials';
import { environments as zhCNEnvironments } from './locales/zh-CN/environments';
import { memory as zhCNMemory } from './locales/zh-CN/memory';
import { navigation as zhCNNavigation } from './locales/zh-CN/navigation';
import { pages as zhCNPages } from './locales/zh-CN/pages';
import { sessions as zhCNSessions } from './locales/zh-CN/sessions';

export const defaultNamespace = 'common';

export const resources = {
  en: {
    agents: enAgents,
    common: enCommon,
    credentials: enCredentials,
    environments: enEnvironments,
    memory: enMemory,
    navigation: enNavigation,
    pages: enPages,
    sessions: enSessions,
  },
  'zh-CN': {
    agents: zhCNAgents,
    common: zhCNCommon,
    credentials: zhCNCredentials,
    environments: zhCNEnvironments,
    memory: zhCNMemory,
    navigation: zhCNNavigation,
    pages: zhCNPages,
    sessions: zhCNSessions,
  },
} as const;
