import {
  Activity,
  Clock,
  Database,
  FileText,
  LayoutDashboard,
  Lock,
  MessageSquare,
  Monitor,
  Server,
  Settings,
  Target,
  Zap,
} from 'lucide-react';
import { EmptyState } from './console-ui';
import { useTranslation } from 'react-i18next';
import { AgentDetail, Agents } from './pages/AgentPages';
import { Files, Skills } from './pages/BuildPages';
import { CredentialVaultDetail, CredentialVaults } from './pages/CredentialPages';
import { EnvironmentDetail, Environments } from './pages/EnvironmentPages';
import { MemoryStoreDetail, MemoryStores } from './pages/MemoryPages';
import { OutcomesPage, ScheduledDeploymentsPage, WebhooksPage } from './pages/OperationsPages';
import { SessionDetail, Sessions } from './pages/SessionPages';
import { SettingsView } from './pages/settings/SettingsView';
import type { Agent, AgentTab, ConsoleData, Environment, MemoryStore, Session, Template, Vault, ViewId } from '../types';

export const NAV_GROUPS: Array<{ label: string; items: Array<{ id: ViewId; label: string; icon: typeof LayoutDashboard }> }> = [
  {
    label: 'Work',
    items: [
      { id: 'agents', label: 'Agents', icon: Monitor },
      { id: 'sessions', label: 'Sessions', icon: MessageSquare },
    ],
  },
  {
    label: 'Resources',
    items: [
      { id: 'environments', label: 'Environments', icon: Server },
      { id: 'credential-vaults', label: 'Credential Vaults', icon: Lock },
      { id: 'memory-stores', label: 'Memory Stores', icon: Database },
    ],
  },
  {
    label: 'Build',
    items: [
      { id: 'files', label: 'Files', icon: FileText },
      { id: 'skills', label: 'Skills', icon: Zap },
    ],
  },
  {
    label: 'Operations',
    items: [
      { id: 'webhooks', label: 'Webhooks', icon: Activity },
      { id: 'scheduled-deployments', label: 'Scheduled', icon: Clock },
      { id: 'outcomes', label: 'Outcomes', icon: Target },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

export const SETTINGS_VIEW_IDS: ViewId[] = [
  'settings',
  'workspace',
  'models',
  'loop-engine',
  'storage',
  'memory',
  'sandbox',
  'web-search',
  'api-keys',
  'api-reference',
  'logs',
  'monitoring',
  'advanced',
];

export function ConsoleRouteView(props: {
  view: ViewId;
  data: ConsoleData;
  setView: (view: ViewId) => void;
  selectedAgentId: string | null;
  selectedSessionId: string | null;
  selectedEnvironmentId: string | null;
  selectedVaultId: string | null;
  selectedMemoryStoreId: string | null;
  agentTab: AgentTab;
  onAgentTab: (tab: AgentTab) => void;
  onOpenAgent: (agent: Agent) => void;
  onOpenSession: (session: Session) => void;
  onOpenEnvironment: (environment: Environment) => void;
  onOpenVault: (vault: Vault) => void;
  onOpenMemoryStore: (store: MemoryStore) => void;
  onEditAgent: (agent: Agent, draft?: Agent) => void;
  onNewAgent: (template: Template | 'blank') => void;
  onNewSession: (agentId?: string) => void;
  onNewCredential: (vaultId: string) => void;
  onNewMemory: (storeId: string) => void;
  onNewResource: (kind: 'environment' | 'credential_vault' | 'memory_store') => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  switch (props.view) {
    case 'agents':
      return <Agents data={props.data} onNewAgent={() => props.onNewAgent('blank')} onOpenAgent={props.onOpenAgent} />;
    case 'agent-detail': {
      const agent = props.data.agents.find((item) => item.id === props.selectedAgentId) ?? props.data.agents[0];
      return agent ? (
        <AgentDetail
          agent={agent}
          data={props.data}
          tab={props.agentTab}
          onTab={props.onAgentTab}
          onBack={() => props.setView('agents')}
          onEdit={(draft) => props.onEditAgent(agent, draft)}
          onNewSession={() => props.onNewSession(agent.id)}
          onOpenSession={props.onOpenSession}
          onRefresh={props.onRefresh}
        />
      ) : <EmptyState icon={Monitor} title={t('routes.noAgent.title')} description={t('routes.noAgent.body')} />;
    }
    case 'sessions':
      return <Sessions data={props.data} onNewSession={() => props.onNewSession()} onOpenSession={props.onOpenSession} />;
    case 'session-detail': {
      const session = props.data.sessions.find((item) => item.id === props.selectedSessionId);
      return session ? (
        <SessionDetail
          session={session}
          data={props.data}
          onBack={() => props.setView('sessions')}
          onRefresh={props.onRefresh}
          onOpenAgent={(agent) => props.onOpenAgent(agent)}
          onNewSession={props.onNewSession}
        />
      ) : <EmptyState icon={MessageSquare} title={t('routes.noSession.title')} description={t('routes.noSession.body')} />;
    }
    case 'environments':
      return <Environments data={props.data} onNew={() => props.onNewResource('environment')} onOpenEnvironment={props.onOpenEnvironment} />;
    case 'environment-detail': {
      const environment = props.data.environments.find((item) => item.id === props.selectedEnvironmentId);
      return environment ? (
        <EnvironmentDetail
          environment={environment}
          data={props.data}
          onBack={() => props.setView('environments')}
          onRefresh={props.onRefresh}
        />
      ) : <EmptyState icon={Server} title={t('routes.noEnvironment.title')} description={t('routes.noEnvironment.body')} />;
    }
    case 'credential-vaults':
      return <CredentialVaults data={props.data} onNew={() => props.onNewResource('credential_vault')} onOpenVault={props.onOpenVault} />;
    case 'credential-vault-detail': {
      const vault = props.data.vaults.find((item) => item.id === props.selectedVaultId);
      return vault ? (
        <CredentialVaultDetail
          vault={vault}
          onBack={() => props.setView('credential-vaults')}
          onRefresh={props.onRefresh}
          onNewCredential={() => props.onNewCredential(vault.id)}
        />
      ) : <EmptyState icon={Lock} title={t('routes.noVault.title')} description={t('routes.noVault.body')} />;
    }
    case 'memory-stores':
      return <MemoryStores data={props.data} onNew={() => props.onNewResource('memory_store')} onOpenMemoryStore={props.onOpenMemoryStore} />;
    case 'memory-store-detail': {
      const store = props.data.memoryStores.find((item) => item.id === props.selectedMemoryStoreId);
      return store ? (
        <MemoryStoreDetail
          store={store}
          onBack={() => props.setView('memory-stores')}
          onRefresh={props.onRefresh}
          onNewMemory={() => props.onNewMemory(store.id)}
        />
      ) : <EmptyState icon={Database} title={t('routes.noMemoryStore.title')} description={t('routes.noMemoryStore.body')} />;
    }
    case 'skills':
      return <Skills data={props.data} onRefresh={props.onRefresh} />;
    case 'files':
      return <Files data={props.data} onRefresh={props.onRefresh} />;
    case 'webhooks':
      return <WebhooksPage data={props.data} onRefresh={props.onRefresh} />;
    case 'scheduled-deployments':
      return <ScheduledDeploymentsPage data={props.data} onRefresh={props.onRefresh} />;
    case 'outcomes':
      return <OutcomesPage data={props.data} onRefresh={props.onRefresh} />;
    case 'workspace':
      return <SettingsView data={props.data} section="workspace" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'advanced':
      return <SettingsView data={props.data} section="advanced" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'models':
      return <SettingsView data={props.data} section="models" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'loop-engine':
      return <SettingsView data={props.data} section="loop-engine" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'storage':
      return <SettingsView data={props.data} section="storage" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'memory':
      return <SettingsView data={props.data} section="memory" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'sandbox':
      return <SettingsView data={props.data} section="sandbox" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'web-search':
      return <SettingsView data={props.data} section="web-search" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'api-keys':
      return <SettingsView data={props.data} section="api-keys" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'api-reference':
      return <SettingsView data={props.data} section="api-reference" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'logs':
      return <SettingsView data={props.data} section="logs" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'monitoring':
      return <SettingsView data={props.data} section="monitoring" onRefresh={props.onRefresh} setView={props.setView} />;
    case 'settings':
      return <SettingsView data={props.data} section="general" onRefresh={props.onRefresh} setView={props.setView} />;
    default:
      return <Agents data={props.data} onNewAgent={() => props.onNewAgent('blank')} onOpenAgent={props.onOpenAgent} />;
  }
}
