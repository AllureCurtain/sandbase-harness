import { Hono, type Handler } from 'hono';

function rejectCapability(id: string, reason: string): Handler {
  return (context) => context.json({
    error: {
      type: 'unsupported_capability',
      message: 'This capability is not supported by SandBase Harness. See docs/api-matrix.md#unsupported-official-routes.',
      details: { capabilities: [{ id, reason }] },
    },
  }, 400);
}

export function unsupportedOfficialRoutes(): Hono {
  const app = new Hono();
  const tunnels = rejectCapability('mcp-tunnel', 'MCP tunnels require hosted connectivity outside the local-first scope.');
  const profiles = rejectCapability('user-profiles', 'Hosted user profile management is outside the single-tenant runtime scope.');

  app.get('/tunnels', tunnels);
  app.post('/tunnels', tunnels);
  app.get('/tunnels/:id', tunnels);
  app.post('/tunnels/:id/archive', tunnels);
  app.post('/tunnels/:id/reveal_token', tunnels);
  app.post('/tunnels/:id/rotate_token', tunnels);
  app.get('/tunnels/:id/certificates', tunnels);
  app.post('/tunnels/:id/certificates', tunnels);
  app.get('/tunnels/:id/certificates/:certificateId', tunnels);
  app.post('/tunnels/:id/certificates/:certificateId/archive', tunnels);

  app.get('/user_profiles', profiles);
  app.post('/user_profiles', profiles);
  app.get('/user_profiles/:id', profiles);
  app.post('/user_profiles/:id', profiles);
  app.post('/user_profiles/:id/enrollment_url', profiles);

  // Every `/v1/sessions/:id/threads*` route — list, retrieve, events, stream,
  // and archive — is mounted for real under `/v1/sessions`
  // (session-threads.ts); nothing of the thread surface remains refused here.

  return app;
}
