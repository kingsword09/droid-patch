/**
 * Shared Factory runtime-compat shims for wrapper-backed Droid sessions.
 *
 * These snippets are injected into the generated runtime proxy scripts used by
 * `--is-custom`, `--skip-login`, `--websearch`, and `--websearch-proxy`.
 *
 * The goal is to keep mission workers, compaction, and other startup flows from
 * depending on a real Factory organization when the session is running through a
 * patched local runtime.
 */

export function generateFactoryCompatPrelude(): string {
  return `
const MOCK_USER_ID = 'f';
const MOCK_ORG_ID = 'f';
const SKIP_LOGIN_PATCHED = process.env.DROID_SKIP_LOGIN === '1';
const FACTORY_COMPAT_PATCHED = process.env.DROID_FACTORY_COMPAT === '1';

function getBearerToken(headers) {
  const auth = headers && headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = auth.match(/^Bearer\\s+(.+)$/i);
  return match ? match[1] : null;
}

function isPatchedFactoryKey(token) {
  return typeof token === 'string' && /^fk/i.test(token);
}

function createMockBillingLimits(overagePreference) {
  return {
    usesTokenRateLimitsBilling: false,
    overagePreference: overagePreference || null,
    extraUsageAllowed: false,
    extraUsageBalanceCents: 0,
    limits: {
      standard: {
        fiveHour: { usedPercent: 0 },
        weekly: { usedPercent: 0 },
        monthly: { usedPercent: 0 },
      },
    },
  };
}

function createMockManagedSettings() {
  return {
    success: true,
    factoryTier: 'team',
    settings: {},
  };
}

function createMockFeatureFlags() {
  return {
    flags: {},
    configs: {},
  };
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
`;
}

export function generateFactoryCompatState(): string {
  return `
let mockedOveragePreference = null;
`;
}

export function generateFactoryCompatRequestGuard(): string {
  return `
  const bearerToken = getBearerToken(req.headers);
  const isPatchedAuthRequest =
    FACTORY_COMPAT_PATCHED || SKIP_LOGIN_PATCHED || isPatchedFactoryKey(bearerToken);
`;
}

export function generateFactoryCompatRoutes(): string {
  return `
  // Patched local sessions do not necessarily have a real Factory organization.
  // Newer Droid mission/compaction flows probe these endpoints before launching
  // worker paths, so we return synthetic responses when runtime compat is active.
  if (isPatchedAuthRequest) {
    if (pathname === '/api/cli/whoami') {
      writeJson(res, 200, { userId: MOCK_USER_ID, orgId: MOCK_ORG_ID });
      return;
    }

    if (pathname === '/api/organization/managed-settings' && req.method === 'GET') {
      writeJson(res, 200, createMockManagedSettings());
      return;
    }

    if (pathname === '/api/feature-flags' && req.method === 'GET') {
      writeJson(res, 200, createMockFeatureFlags());
      return;
    }

    if (pathname === '/api/billing/limits' && req.method === 'GET') {
      writeJson(res, 200, createMockBillingLimits(mockedOveragePreference));
      return;
    }

    if (pathname === '/api/organization/subscription/set-overage-preference' && req.method === 'POST') {
      let body = '';
      req.on('data', function(c) { body += c; });
      req.on('end', function() {
        let requestedPreference = null;
        if (body) {
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed.overagePreference === 'string') {
              requestedPreference = parsed.overagePreference;
            }
          } catch {}
        }

        mockedOveragePreference = requestedPreference;
        writeJson(res, 200, {
          ok: true,
          overagePreference: mockedOveragePreference,
        });
      });
      return;
    }
  }
`;
}
