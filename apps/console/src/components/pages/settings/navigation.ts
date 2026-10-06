import { Box, Keyboard, KeyRound, Settings, SlidersHorizontal } from 'lucide-react';
import type { ViewId } from '../../../types';

export const SETTINGS_SECTIONS = [
  { id: 'general', labelKey: 'nav.sections.general', icon: Settings, group: 'project' },
  { id: 'workspace', labelKey: 'nav.sections.workspace', icon: Box, group: 'project' },
  { id: 'api-keys', labelKey: 'nav.sections.apiKeys', icon: KeyRound, group: 'access' },
  { id: 'api-reference', labelKey: 'nav.sections.apiReference', icon: Keyboard, group: 'developer' },
  { id: 'advanced', labelKey: 'nav.sections.advanced', icon: SlidersHorizontal, group: 'developer' },
] as const;

type VisibleSettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export type SettingsSection = VisibleSettingsSection
  | 'models'
  | 'loop-engine'
  | 'storage'
  | 'memory'
  | 'sandbox'
  | 'logs'
  | 'monitoring';
export const SETTINGS_GROUPS = ['project', 'access', 'developer'] as const;
export const SETTINGS_GROUP_LABEL_KEYS = {
  project: 'nav.groups.project',
  access: 'nav.groups.access',
  developer: 'nav.groups.developer',
} as const;
export const SETTINGS_VIEW_IDS: ViewId[] = [
  'settings', 'workspace', 'models', 'loop-engine', 'storage',
  'memory', 'sandbox', 'api-keys', 'api-reference', 'logs', 'monitoring', 'advanced',
];
