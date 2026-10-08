import { FolderDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getJson, getPage, postJson } from '../../api';
import { StatusDot } from '../console-ui';
import { Modal } from '../Modal';
import { downloadJson, formatDateShort, shortId } from '../../lib/format';
import type { HandoffBundleSummary, McpServerStatus, Session } from '../../types';

type McpStatusResponse = {
  session_id: string;
  servers: McpServerStatus[];
};

/**
 * Per-server MCP connection health for this session, from
 * `GET /v1/x/mcp/status?session_id=…`. Read-only: reconnect/repair is the
 * runtime's job, this view only reports what the resolver recorded.
 */
export function SessionMcpStatusModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const { t } = useTranslation('sessions');
  const [servers, setServers] = useState<McpServerStatus[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getJson<McpStatusResponse>(`/v1/x/mcp/status?session_id=${encodeURIComponent(session.id)}`)
      .then((res) => { if (!cancelled) setServers(res.servers); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [session.id]);

  return (
    <Modal title={t('modal.mcpStatus.title')} subtitle={session.id} onClose={onClose}>
      {error ? <p className="mutedLine" role="alert">{error}</p> : null}
      {servers === null && !error ? <p className="mutedLine">{t('modal.mcpStatus.loading')}</p> : null}
      {servers !== null && servers.length === 0 ? (
        <p className="mutedLine">{t('modal.mcpStatus.empty')}</p>
      ) : null}
      {servers && servers.length > 0 ? (
        <div className="table-frame">
          <table className="data-table" aria-label={t('modal.mcpStatus.title')}>
            <thead>
              <tr>
                <th scope="col">{t('modal.mcpStatus.columns.name')}</th>
                <th scope="col">{t('modal.mcpStatus.columns.type')}</th>
                <th scope="col">{t('modal.mcpStatus.columns.state')}</th>
                <th scope="col">{t('modal.mcpStatus.columns.tools')}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.name}>
                  <td><strong className="monoText">{server.name}</strong>{server.error ? <p className="mutedLine" role="alert">{server.error}</p> : null}</td>
                  <td>{server.type}</td>
                  <td><StatusDot tone={server.connected ? 'ok' : 'danger'} label={server.connected ? t('modal.mcpStatus.connected') : t('modal.mcpStatus.disconnected')} /></td>
                  <td>{server.toolCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
}

type HandoffListResponse = {
  data: HandoffBundleSummary[];
};

/**
 * The session's handoff bundles (`/v1/x/handoff-bundles`) plus the published
 * builder (`POST /v1/x/sessions/{id}/handoff-bundle`). Content inclusion is
 * opt-in exactly like the route's flags — the default export carries digests
 * only, matching the API's own OTel-style default.
 */
export function SessionHandoffBundlesModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const { t } = useTranslation('sessions');
  const [bundles, setBundles] = useState<HandoffBundleSummary[] | null>(null);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [includeMessages, setIncludeMessages] = useState(false);
  const [includeFiles, setIncludeFiles] = useState(false);
  const [building, setBuilding] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPage<HandoffBundleSummary>(`/v1/x/handoff-bundles?session_id=${encodeURIComponent(session.id)}&limit=50`)
      .then((page) => { if (!cancelled) setBundles(page.data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [session.id]);

  const build = async () => {
    setBuilding(true);
    setError('');
    try {
      const bundle = await postJson<HandoffBundleSummary>(`/v1/x/sessions/${encodeURIComponent(session.id)}/handoff-bundle`, {
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(includeMessages ? { include_message_content: true } : {}),
        ...(includeFiles ? { include_file_content: true } : {}),
      });
      setBundles((prev) => [bundle, ...(prev ?? [])]);
      setLabel('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  };

  const download = async (bundle: HandoffBundleSummary) => {
    setDownloading(bundle.id);
    setError('');
    try {
      const payload = await getJson(`/v1/x/handoff-bundles/${encodeURIComponent(bundle.id)}`);
      downloadJson(`handoff-${bundle.id}.json`, payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Modal title={t('modal.handoffs.title')} subtitle={session.id} onClose={onClose}>
      <div className="handoffBuildRow">
        <input
          type="text"
          value={label}
          placeholder={t('modal.handoffs.labelPlaceholder')}
          onChange={(event) => setLabel(event.target.value)}
        />
        <label className="checkboxLine">
          <input type="checkbox" checked={includeMessages} onChange={(event) => setIncludeMessages(event.target.checked)} />
          {t('modal.handoffs.includeMessages')}
        </label>
        <label className="checkboxLine">
          <input type="checkbox" checked={includeFiles} onChange={(event) => setIncludeFiles(event.target.checked)} />
          {t('modal.handoffs.includeFiles')}
        </label>
        <button className="button primary" type="button" onClick={() => void build()} disabled={building}>
          <FolderDown size={15} />
          {building ? t('modal.handoffs.building') : t('modal.handoffs.build')}
        </button>
      </div>
      {error ? <p className="mutedLine" role="alert">{error}</p> : null}
      {bundles === null && !error ? <p className="mutedLine">{t('modal.handoffs.loading')}</p> : null}
      {bundles !== null && bundles.length === 0 ? (
        <p className="mutedLine">{t('modal.handoffs.empty')}</p>
      ) : null}
      {bundles && bundles.length > 0 ? (
        <div className="table-frame">
          <table className="data-table" aria-label={t('modal.handoffs.title')}>
            <thead>
              <tr>
                <th scope="col">{t('modal.handoffs.columns.id')}</th>
                <th scope="col">{t('modal.handoffs.columns.label')}</th>
                <th scope="col">{t('modal.handoffs.columns.events')}</th>
                <th scope="col">{t('modal.handoffs.columns.created')}</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {bundles.map((bundle) => (
                <tr key={bundle.id}>
                  <td><strong className="monoText">{shortId(bundle.id)}</strong></td>
                  <td>{bundle.label ?? '—'}</td>
                  <td>{bundle.event_count} / {bundle.file_count}</td>
                  <td>{formatDateShort(bundle.created_at)}</td>
                  <td>
                    <button
                      className="button outline"
                      type="button"
                      disabled={downloading === bundle.id}
                      onClick={() => void download(bundle)}
                    >
                      {t('modal.handoffs.download')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
}
