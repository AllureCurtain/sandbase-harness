/**
 * Extension Routes (/v1/x/*)
 *
 * Runtime extension composition root.
 *
 * The legacy provider CRUD routes (`/model-providers`, `/memory-providers`,
 * `/storage-providers`) are deliberately absent: they were removed from the v1
 * surface in favor of the canonical `/v1/x/settings` document, and
 * tests/unit/v1-local-first-spec.test.ts asserts they stay gone.
 */

import { Hono } from 'hono';
import type { ServerDeps } from '../server.js';
import { runtimeRoutes } from './runtime.js';
import { settingsRoutes } from './settings.js';
import { templateRoutes } from './templates.js';

export function extendedRoutes(deps: ServerDeps) {
  const app = new Hono();
  app.route('/', runtimeRoutes(deps));
  app.route('/settings', settingsRoutes(deps));
  app.route('/templates', templateRoutes(deps));
  return app;
}
