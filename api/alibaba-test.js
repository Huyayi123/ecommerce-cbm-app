import { AlibabaError, parseDiagnosticInput, queryAlibabaLogistics } from './_lib/alibabaClient.js';

export async function authorizeAdmin(request, env, fetcher, roles = ['owner', 'admin']) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) throw new AlibabaError('LOGIN_REQUIRED', 401);
  const base = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
  if (!base || !key) throw new AlibabaError('SUPABASE_CONFIG_MISSING', 503);
  let url;
  try { url = new URL(base); } catch { throw new AlibabaError('SUPABASE_CONFIG_MISSING', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new AlibabaError('SUPABASE_CONFIG_MISSING', 503);
  const headers = { apikey: key, Authorization: authorization, Accept: 'application/json' };
  // Validate the JWT via Supabase Auth; never decode claims and trust them locally.
  const userResponse = await fetcher(`${url.origin}/auth/v1/user`, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!userResponse.ok) throw new AlibabaError('LOGIN_REQUIRED', 401);
  const user = await userResponse.json();
  if (typeof user.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(user.id)) throw new AlibabaError('LOGIN_REQUIRED', 401);
  const memberUrl = new URL(`${url.origin}/rest/v1/alibaba_logistics_users`);
  memberUrl.searchParams.set('select', 'user_id,logistics_role,enabled');
  memberUrl.searchParams.set('user_id', `eq.${user.id}`);
  const memberResponse = await fetcher(memberUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!memberResponse.ok) throw new AlibabaError('LOGISTICS_PERMISSIONS_UNAVAILABLE', 503);
  const members = await memberResponse.json();
  if (!Array.isArray(members) || !members.some((member) => member.user_id === user.id
    && member.enabled === true && roles.includes(member.logistics_role))) throw new AlibabaError('ADMIN_REQUIRED', 403);
  return { userId: user.id, origin: url.origin, headers };
}

// Preview-only diagnostic, explicitly independent of the disabled synchronization switch.
// No database writes, no service_role key, no cron and no automatic retries.
export function createAlibabaTestHandler({ env = process.env, fetcher = fetch, query = queryAlibabaLogistics } = {}) {
  let nextAllowedAt = 0;
  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store, private');
    response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    if (env.VERCEL_ENV !== 'preview') return response.status(404).json({ error: 'NOT_AVAILABLE' });
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' }); }
    try {
      const contentType = request.headers['content-type'] || '';
      if (!contentType.toLowerCase().startsWith('application/json')) throw new AlibabaError('INVALID_INPUT', 400);
      const input = parseDiagnosticInput(request.body);
      await authorizeAdmin(request, env, fetcher);
      // Conservative instance-level pilot throttle, not a global quota mechanism.
      // Production synchronization remains disabled until a durable limiter exists.
      if (Date.now() < nextAllowedAt) throw new AlibabaError('WAIT_BEFORE_RETRY', 429);
      nextAllowedAt = Date.now() + 15000;
      const result = await query(input, env, fetcher);
      return response.status(200).json({ ok: true, account: input.account, ...result, checkedAt: new Date().toISOString(), readOnly: true });
    } catch (error) {
      const known = error instanceof AlibabaError;
      return response.status(known ? error.status : 502).json({ error: known ? error.code : 'SERVICE_UNAVAILABLE' });
    }
  };
}

export default createAlibabaTestHandler();
