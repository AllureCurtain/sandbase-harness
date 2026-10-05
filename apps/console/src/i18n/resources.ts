import { common as enCommon } from './locales/en/common';
import { navigation as enNavigation } from './locales/en/navigation';
import { pages as enPages } from './locales/en/pages';
import { common as zhCNCommon } from './locales/zh-CN/common';
import { navigation as zhCNNavigation } from './locales/zh-CN/navigation';
import { pages as zhCNPages } from './locales/zh-CN/pages';

export const defaultNamespace = 'common';

export const resources = {
  en: {
    common: enCommon,
    navigation: enNavigation,
    pages: enPages,
  },
  'zh-CN': {
    common: zhCNCommon,
    navigation: zhCNNavigation,
    pages: zhCNPages,
  },
} as const;
