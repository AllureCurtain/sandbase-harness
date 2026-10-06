import { Copy, Search } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { ConsoleData } from '../../../types';
import { copyText } from '../../../lib/format';
import { PageHeader } from '../../console-ui';
import { ApiCodeCard, ApiMethodBadge, ApiParamSection } from './ApiReferencePrimitives';
import type { ApiReferenceEndpoint } from './apiReferenceTypes';
import {
  buildApiEndpointExample,
  buildSdkSnippet,
  skillAttachSnippet,
  skillJsonSnippet,
  type ApiReferenceExampleContext,
} from './apiReferenceExamples';
import {
  buildDefaultHeaders,
  getEndpointGroups,
  getVisibleApiEndpoints,
  selectVisibleApiEndpoint,
} from './apiReferenceSelectors';

type SettingsApiReferenceProps = {
  data: ConsoleData;
  docs: ApiReferenceEndpoint[];
};

export const DEFAULT_API_REFERENCE_ENDPOINT_ID = 'sessions-create';

export function SettingsApiReference({ data, docs }: SettingsApiReferenceProps) {
  const { t } = useTranslation('settings');
  const baseUrl = typeof window === 'undefined' ? 'http://127.0.0.1:3000' : window.location.origin;
  const authEnabled = data.runtime?.auth_enabled ?? false;
  const firstAgentId = data.agents[0]?.id ?? 'agent_...';
  const firstEnvironmentId = data.environments[0]?.id ?? 'env_...';
  const firstSessionId = data.sessions[0]?.id ?? 'sess_...';
  const exampleContext: ApiReferenceExampleContext = {
    baseUrl,
    authEnabled,
    firstAgentId,
    firstEnvironmentId,
    firstSessionId,
  };
  const sdkSnippet = buildSdkSnippet(exampleContext);
  const [activeEndpointId, setActiveEndpointId] = useState(DEFAULT_API_REFERENCE_ENDPOINT_ID);
  const [search, setSearch] = useState('');
  const visibleDocs = getVisibleApiEndpoints(docs, search);
  const endpointGroups = getEndpointGroups(visibleDocs);
  const activeEndpoint = selectVisibleApiEndpoint(visibleDocs, activeEndpointId);
  const showSkillNotes = activeEndpoint?.group === 'Skills';

  if (docs.length === 0) {
    return (
      <section className="stack apiReference">
        <PageHeader title={t('apiReference.title')} description={t('apiReference.emptyDocs')} />
      </section>
    );
  }

  if (!activeEndpoint) {
    return (
      <section className="stack apiReference">
        <PageHeader title={t('apiReference.title')} description={t('apiReference.description')} />

        <div className="apiDocsShell">
          <aside className="apiDocsNav" aria-label={t('apiReference.navLabel')}>
            <label className="apiDocsSearch">
              <Search size={15} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('apiReference.searchPlaceholder')} />
            </label>
            <div className="apiDocsRuntime">
              <span>{t('apiReference.baseUrl')}</span>
              <code>{baseUrl}</code>
            </div>
            <p className="formHint">{t('apiReference.noMatches')}</p>
          </aside>

          <article className="apiDocsArticle">
            <h2>{t('apiReference.noEndpoint')}</h2>
            <p className="apiDocsSummary">{t('apiReference.noEndpointHint')}</p>
          </article>
        </div>
      </section>
    );
  }

  const headers = activeEndpoint.headers ?? buildDefaultHeaders(activeEndpoint, authEnabled);
  const endpointExample = buildApiEndpointExample(activeEndpoint, exampleContext);

  return (
    <section className="stack apiReference">
      <PageHeader title={t('apiReference.title')} description={t('apiReference.description')} />

      <div className="apiDocsShell">
        <aside className="apiDocsNav" aria-label={t('apiReference.navLabel')}>
          <label className="apiDocsSearch">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('apiReference.searchPlaceholder')} aria-label={t('apiReference.searchPlaceholder')} />
          </label>
          <div className="apiDocsRuntime">
            <span>{t('apiReference.baseUrl')}</span>
            <code>{baseUrl}</code>
          </div>
          {endpointGroups.map((group) => (
            <div className="apiDocsNavGroup" key={group}>
              <strong>{group}</strong>
              {visibleDocs.filter((endpoint) => endpoint.group === group).map((endpoint) => (
                <button
                  type="button"
                  key={endpoint.id}
                  className={`apiDocsNavItem ${endpoint.id === activeEndpoint.id ? 'active' : ''}`}
                  aria-current={endpoint.id === activeEndpoint.id ? 'page' : undefined}
                  onClick={() => setActiveEndpointId(endpoint.id)}
                >
                  <ApiMethodBadge method={endpoint.method} variant="square" />
                  <span>{endpoint.title}</span>
                </button>
              ))}
            </div>
          ))}
          {visibleDocs.length === 0 ? <p className="formHint">{t('apiReference.noMatches')}</p> : null}
        </aside>

        <article className="apiDocsArticle">
          <div className="apiDocsArticleHeader">
            <div>
              <h2>{activeEndpoint.title}</h2>
              <div className="apiDocsPath">
                <ApiMethodBadge method={activeEndpoint.method} />
                <code>{activeEndpoint.path}</code>
              </div>
            </div>
            <button className="secondaryButton" type="button" onClick={() => copyText(`${activeEndpoint.method} ${activeEndpoint.path}`)}>
              <Copy size={15} /> {t('apiReference.copyEndpoint')}
            </button>
          </div>
          <p className="apiDocsSummary">{activeEndpoint.summary}</p>

          <ApiParamSection title={t('apiReference.headerParams')} fields={headers} emptyLabel={t('apiReference.headerParamsEmpty')} />

          <ApiParamSection
            title={activeEndpoint.method === 'GET' ? t('apiReference.queryParams') : t('apiReference.bodyParams')}
            fields={activeEndpoint.parameters ?? []}
            emptyLabel={activeEndpoint.method === 'GET' ? t('apiReference.queryParamsEmpty') : t('apiReference.bodyParamsEmpty')}
          />

          <ApiParamSection title={t('apiReference.returns')} fields={activeEndpoint.response} emptyLabel={t('apiReference.returnsEmpty')} response />

          {showSkillNotes ? <section className="apiDocsSection">
            <h3>{t('apiReference.skillsNotes.title')}</h3>
            <p><Trans i18nKey="apiReference.skillsNotes.body" ns="settings" components={{ code: <code /> }} /></p>
            <pre className="metricsPreview">code-review-assistant/{'\n'}  SKILL.md{'\n'}  references/checklist.md</pre>
          </section> : null}

          <section className="apiDocsSection apiDocsExamples" aria-label={t('apiReference.examples')}>
            <h3>{t('apiReference.examples')}</h3>
            <div className="apiDocsExampleGrid">
              <ApiCodeCard title={t('apiReference.exampleRequest')} code={endpointExample} copyLabel={t('apiReference.copyRequest')} />
              <ApiCodeCard title={t('apiReference.sdkSnippet')} code={sdkSnippet} copyLabel={t('apiReference.copySdk')} />
              <ApiCodeCard title={t('apiReference.skillJson')} code={skillJsonSnippet} copyLabel={t('apiReference.copySkillJson')} />
              <ApiCodeCard title={t('apiReference.skillAttach')} code={skillAttachSnippet} />
            </div>
          </section>
        </article>
      </div>
    </section>
  );
}
