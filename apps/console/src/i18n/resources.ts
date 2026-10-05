import { agents as enAgents } from './locales/en/agents';
import { common as enCommon } from './locales/en/common';
import { navigation as enNavigation } from './locales/en/navigation';
import { pages as enPages } from './locales/en/pages';
import { agents as zhCNAgents } from './locales/zh-CN/agents';
import { common as zhCNCommon } from './locales/zh-CN/common';
import { navigation as zhCNNavigation } from './locales/zh-CN/navigation';
import { pages as zhCNPages } from './locales/zh-CN/pages';

export const defaultNamespace = 'common';

export const resources = {
  en: {
    agents: enAgents,
    common: enCommon,
    navigation: enNavigation,
    pages: enPages,
  },
  'zh-CN': {
    agents: zhCNAgents,
    common: zhCNCommon,
    navigation: zhCNNavigation,
    pages: zhCNPages,
  },
} as const;
