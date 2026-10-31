import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Installation, parseInstallationCredentials, parseMcpBody, redact } from './lib/client.mjs';
import { classifyMcp, classifyRest, classifyRow, evaluateGate, parseApprovals } from './lib/outcome.mjs';
import { buildMcpArguments, FAKE_UUID, MALFORMED_JSON, planRestProbes } from './lib/plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('classifyRest', () => {
  it('reads auth refusals, validation, lookups and unknown paths', () => {
    assert.equal(classifyRest({ status: 201 }), 'allowed');
    assert.equal(classifyRest({ status: 302 }), 'allowed');
    assert.equal(classifyRest({ status: 401, code: 'UNAUTHORIZED' }), 'denied');
    assert.equal(classifyRest({ status: 403, code: 'PERMISSION_DENIED' }), 'denied');
    assert.equal(classifyRest({ status: 403, code: 'IMPERSONATION_CREDENTIAL_ISSUANCE_FORBIDDEN' }), 'denied');
    assert.equal(classifyRest({ status: 403, code: 'LICENSE_ENTITLEMENT_REQUIRED' }), 'other');
    assert.equal(classifyRest({ status: 400, code: 'VALIDATION_ERROR' }), 'validation');
    assert.equal(classifyRest({ status: 404, code: 'NOT_FOUND', message: 'Token not found' }), 'not_found');
    assert.equal(
      classifyRest({ status: 404, code: 'NOT_FOUND', message: 'No API endpoint at POST /api/inference/tokens' }),
      'missing'
    );
    assert.equal(classifyRest({ status: 409, code: 'CONFLICT' }), 'other');
    assert.equal(classifyRest({ status: 503, code: 'LOGGING_DISABLED' }), 'other');
    assert.equal(classifyRest({ status: 501, code: 'OCSP_DISABLED' }), 'other');
    assert.equal(classifyRest({ status: 503, code: 'SERVICE_RESTARTING' }), 'error');
    assert.equal(classifyRest({ status: 502 }), 'error');
    assert.equal(classifyRest({ status: 429 }), 'error');
    assert.equal(classifyRest({ error: 'timeout after 15000 ms' }), 'error');
  });
});

describe('classifyMcp', () => {
  it('tells a refusal from a validation error', () => {
    assert.equal(
      classifyMcp({ httpStatus: 200, isError: true, text: 'Tool "manage_nodes" is unavailable for this MCP token' }),
      'denied'
    );
    assert.equal(
      classifyMcp({ httpStatus: 200, isError: true, text: 'Invalid tool arguments: operation must be one of: list' }),
      'validation'
    );
    assert.equal(
      classifyMcp({
        httpStatus: 200,
        isError: true,
        text: 'Inference keys are created and changed from a browser session; remote MCP can list and revoke them',
      }),
      'denied'
    );
    assert.equal(classifyMcp({ httpStatus: 200, isError: true, text: 'Inference token not found' }), 'not_found');
    assert.equal(
      classifyMcp({ httpStatus: 200, isError: true, text: 'IDEMPOTENCY_KEY_INVALID: idempotencyKey must be 1-255 printable ASCII characters.' }),
      'validation'
    );
    assert.equal(classifyMcp({ httpStatus: 200, isError: false, text: '[]' }), 'allowed');
    assert.equal(classifyMcp({ httpStatus: 401, message: 'MCP requires OAuth bearer token authentication' }), 'denied');
    assert.equal(classifyMcp({ httpStatus: 200, rpcError: { code: -32602, message: 'bad' } }), 'validation');
    assert.equal(classifyMcp({ error: 'timeout' }), 'error');
  });
});

describe('classifyRow', () => {
  const row = (baseline, candidate, inBaseline = true, inCandidate = true) =>
    classifyRow({ baseline, candidate, inBaseline, inCandidate });

  it('flags the 2.13.0 OAuth inference-key refusal as narrowed', () => {
    // POST /api/inference/tokens with an opfo_ token: 201 on 2.12.8, 403 on 2.13.0.
    assert.equal(row(classifyRest({ status: 201 }), classifyRest({ status: 403, code: 'PERMISSION_DENIED' })), 'narrowed');
    // The same with a malformed body: 400 before, 403 after.
    assert.equal(row('validation', 'denied'), 'narrowed');
    assert.equal(row('not_found', 'denied'), 'narrowed');
  });

  it('classifies widened, same, removed, added and inconclusive', () => {
    assert.equal(row('denied', 'validation'), 'widened');
    assert.equal(row('denied', 'denied'), 'same');
    assert.equal(row('not_found', 'validation'), 'same');
    assert.equal(row('allowed', 'allowed'), 'same');
    assert.equal(row('validation', 'validation', true, false), 'removed');
    assert.equal(row('missing', 'validation', false, true), 'added');
    assert.equal(row('validation', 'missing'), 'removed');
    assert.equal(row('missing', 'validation'), 'added');
    assert.equal(row('validation', 'error'), 'inconclusive');
    assert.equal(row('error', 'error'), 'same');
    assert.equal(row(null, null), 'skipped');
  });
});

describe('approvals and the gate', () => {
  const rows = () => [
    { route: 'POST /api/inference/tokens', credential: 'oauthApi', class: 'narrowed' },
    { route: 'GET /api/nodes/{nodeId}', credential: 'apiTokenNarrow', class: 'narrowed' },
    { route: 'GET /api/old', credential: 'apiToken', class: 'removed' },
    { route: 'GET /api/old', credential: 'session', class: 'removed' },
    { route: 'GET /api/x', credential: 'apiToken', class: 'widened' },
    { route: 'GET /api/y', credential: 'apiToken', class: 'inconclusive' },
  ];

  it('fails on unapproved narrowed and removed rows only', () => {
    const gate = evaluateGate(rows(), []);
    assert.equal(gate.failed, true);
    assert.equal(gate.blocking.length, 4);
    assert.equal(gate.counts.widened, 1);
  });

  it('passes when every narrowing is approved; parameter names and credential wildcards match', () => {
    const { approvals, problems } = parseApprovals({
      approvals: [
        { route: 'POST /api/inference/tokens', credential: 'oauthApi', reason: 'r', approvedBy: 'owner', date: '2026-10-31' },
        { route: 'GET /api/nodes/{id}', credential: 'apiTokenNarrow', reason: 'r', approvedBy: 'owner', date: '2026-10-31' },
        { route: 'GET /api/old', credential: '*', change: 'removed', reason: 'r', approvedBy: 'owner', date: '2026-10-31' },
        { route: 'GET /api/unused', credential: '*', reason: 'r', approvedBy: 'owner', date: '2026-10-31' },
      ],
    });
    assert.deepEqual(problems, []);
    const list = rows();
    const gate = evaluateGate(list, approvals);
    assert.equal(gate.failed, false);
    assert.equal(list[0].approval.approvedBy, 'owner');
    assert.equal(gate.unusedApprovals.length, 1);
    assert.equal(evaluateGate(rows(), approvals, { strict: true }).failed, true);
  });

  it('rejects approvals without reason, approver or date', () => {
    const { problems } = parseApprovals({ approvals: [{ route: 'GET /a', credential: '*', date: '31.10.2026' }] });
    assert.ok(problems.some((problem) => problem.includes('reason')));
    assert.ok(problems.some((problem) => problem.includes('approvedBy')));
    assert.ok(problems.some((problem) => problem.includes('YYYY-MM-DD')));
  });
});

const doc = (paths) => ({ openapi: '3.1.0', paths });
const jsonBody = {
  required: true,
  content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
};
const optionalBody = { required: false, content: { 'application/json': { schema: { type: 'object' } } } };

describe('planRestProbes', () => {
  it('sends GETs as they are and writes that cannot act', () => {
    const baseline = doc({
      '/api/nodes/{id}': {
        get: { parameters: [{ in: 'path', name: 'id', schema: { type: 'string', format: 'uuid' } }] },
        delete: { parameters: [{ in: 'path', name: 'id', schema: { type: 'string' } }] },
      },
      '/api/inference/tokens': { post: { requestBody: jsonBody } },
      '/api/system/restart': { post: {} },
      '/api/settings/{section}': { post: { parameters: [{ in: 'path', name: 'section', schema: { enum: ['a', 'b'] } }] } },
      '/auth/logout': { post: {} },
      '/api/old': { get: {} },
      '/api/docker/registries/internal/gc': { post: { requestBody: optionalBody } },
      '/api/system/update': { post: { requestBody: jsonBody } },
      '/api/settings': { patch: { requestBody: { ...jsonBody, required: false } } },
    });
    const candidate = doc({
      '/api/nodes/{nodeId}': {
        get: { parameters: [{ in: 'path', name: 'nodeId', schema: { type: 'string', format: 'uuid' } }] },
        delete: { parameters: [{ in: 'path', name: 'nodeId', schema: { type: 'string' } }] },
      },
      '/api/inference/tokens': { post: { requestBody: jsonBody } },
      '/api/system/restart': { post: {} },
      '/api/settings/{section}': { post: { parameters: [{ in: 'path', name: 'section', schema: { enum: ['a', 'b'] } }] } },
      '/auth/logout': { post: {} },
      '/api/new': { get: {} },
    });
    const probes = new Map(planRestProbes(baseline, candidate).map((probe) => [probe.route, probe]));

    const get = probes.get('GET /api/nodes/{nodeId}');
    assert.equal(get.inBaseline && get.inCandidate, true, 'renamed path parameters still match');
    assert.equal(get.request.path, `/api/nodes/${FAKE_UUID}`);
    assert.equal(get.request.body, undefined);

    const del = probes.get('DELETE /api/nodes/{nodeId}');
    assert.equal(del.request.path, `/api/nodes/${FAKE_UUID}`, 'deletes point at an id that does not exist');

    assert.equal(probes.get('POST /api/inference/tokens').request.body, MALFORMED_JSON);
    assert.match(probes.get('POST /api/system/restart').request.skip, /would act for real/);
    assert.match(probes.get('POST /api/settings/{section}').request.skip, /would act for real/);
    assert.match(probes.get('POST /auth/logout').request.skip, /end the probing session/);
    assert.match(probes.get('POST /api/docker/registries/internal/gc').request.skip, /global action|optional/);
    assert.match(probes.get('POST /api/system/update').request.skip, /global action/);
    assert.match(probes.get('PATCH /api/settings').request.skip, /optional/);
    assert.equal(probes.get('GET /api/old').inCandidate, false);
    assert.equal(probes.get('GET /api/new').inBaseline, false);
  });
});

describe('buildMcpArguments', () => {
  it('makes every typed argument wrong', () => {
    const built = buildMcpArguments({
      name: 'manage_inference_token',
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list', 'create'] },
          tokenId: { type: 'string' },
          expiresAt: { type: ['string', 'null'] },
          allowedIps: { type: 'array' },
          page: { type: 'number' },
        },
        required: ['operation'],
      },
    });
    assert.equal(typeof built.arguments.operation, 'object');
    assert.equal(typeof built.arguments.tokenId, 'object');
    assert.equal(typeof built.arguments.expiresAt, 'object');
    assert.equal(Array.isArray(built.arguments.allowedIps), false);
    assert.equal(typeof built.arguments.page, 'object');
  });

  it('calls argument-free read-only tools as they are and skips argument-free writes', () => {
    assert.deepEqual(buildMcpArguments({ name: 'list_nodes', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }), {
      arguments: {},
    });
    assert.match(
      buildMcpArguments({ name: 'refresh', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }).skip,
      /would act for real/
    );
    assert.equal(
      buildMcpArguments({ name: 'strict', inputSchema: { type: 'object', additionalProperties: false } }).arguments
        .__access_diff_unknown_argument__,
      true
    );
  });
});

describe('client helpers', () => {
  it('parses SSE and JSON MCP answers', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n';
    assert.deepEqual(parseMcpBody(sse, 7).result, { tools: [] });
    assert.equal(parseMcpBody('{"jsonrpc":"2.0","id":3,"result":{}}', 3).id, 3);
  });

  it('redacts token-shaped strings and the given secrets', () => {
    assert.equal(redact('Bearer opf_abcdef123456 and opfo_zzzzzz999', []), 'Bearer [redacted] and [redacted]');
    assert.equal(redact('cookie s3cr3t-value', ['s3cr3t-value']), 'cookie [redacted]');
  });

  it('keeps the rate-limit reserve: every worker waits for the window, and one origin shares one budget', async () => {
    const options = { timeoutMs: 1000, reserve: 0.25, maxRetries: 0, log: () => {} };
    const a = new Installation('baseline', 'http://pace.test:1', options);
    const b = new Installation('candidate', 'http://pace.test:1/', options);
    const headers = new Headers({ 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '25', 'x-ratelimit-reset': '0' });
    a.noteRateHeaders('api:ip', headers);
    assert.equal(b.buckets, a.buckets, 'same origin, same budget');
    a.buckets.get('api:ip').resetAt = Date.now() + 300;
    const started = Date.now();
    await Promise.all([a.pace('api:ip'), b.pace('api:ip')]);
    assert.ok(Date.now() - started >= 250, 'both waited for the window');
  });

  it('reads the credential kinds and reports missing ones', () => {
    const parsed = parseInstallationCredentials({
      session: { cookie: 'a=b', csrf: 'c' },
      apiToken: 'opf_x',
      custom: { token: 'opf_y' },
    });
    assert.deepEqual(
      parsed.credentials.map((credential) => credential.id),
      ['anonymous', 'session', 'apiToken', 'custom']
    );
    assert.ok(parsed.missing.includes('oauthMcp'));
  });
});

// One run of the CLI against two small fake installations: the candidate refuses OAuth tokens on
// POST /api/inference/tokens (the 2.13.0 incident) and dropped one route.
describe('run.mjs against fake installations', () => {
  function fakeOpfield({ refuseOauthOnInferenceTokens, dropOld }) {
    const paths = {
      '/api/inference/tokens': { get: {}, post: { requestBody: jsonBody } },
      '/api/nodes/{id}': { get: { parameters: [{ in: 'path', name: 'id', schema: { type: 'string', format: 'uuid' } }] } },
      '/api/system/restart': { post: {} },
      ...(dropOld ? {} : { '/api/old': { get: {} } }),
    };
    const seen = [];
    const server = createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      const kind = auth.startsWith('Bearer opfo_') ? 'oauth' : auth.startsWith('Bearer opf_') ? 'api' : 'none';
      const url = new URL(req.url, 'http://x');
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method, path: url.pathname, body });
        const json = (status, value) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        if (url.pathname === '/health') return json(200, kind === 'none' ? { status: 'ok' } : { status: 'ok', version: 'test' });
        if (url.pathname === '/api/mcp') return json(401, { code: 'UNAUTHORIZED', message: 'MCP accepts only OAuth' });
        if (kind === 'none') return json(401, { code: 'UNAUTHORIZED', message: 'Authentication required' });
        if (url.pathname === '/api/openapi.json') return json(200, doc(paths));
        if (url.pathname === '/api/inference/tokens' && req.method === 'POST') {
          if (refuseOauthOnInferenceTokens && kind === 'oauth') {
            return json(403, { code: 'PERMISSION_DENIED', message: 'This endpoint requires browser session authentication.' });
          }
          try {
            JSON.parse(body);
          } catch {
            return json(400, { code: 'VALIDATION_ERROR', message: 'Malformed JSON in request body' });
          }
          return json(201, {});
        }
        if (url.pathname === '/api/inference/tokens') return json(200, []);
        if (url.pathname.startsWith('/api/nodes/')) return json(404, { code: 'NOT_FOUND', message: 'Node not found' });
        if (url.pathname === '/api/old' && !dropOld) return json(200, {});
        if (url.pathname === '/api/system/restart') throw new Error('the restart action must never be called');
        return json(404, { code: 'NOT_FOUND', message: `No API endpoint at ${req.method} ${url.pathname}` });
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
    });
  }

  function runCli(args) {
    return new Promise((resolve) => {
      execFile(process.execPath, [join(HERE, 'run.mjs'), ...args], { timeout: 60_000 }, (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr })
      );
    });
  }

  it('reports the narrowing and the removal, fails, and passes once both are approved', async (t) => {
    let baseline;
    let candidate;
    try {
      baseline = await fakeOpfield({ refuseOauthOnInferenceTokens: false, dropOld: false });
      candidate = await fakeOpfield({ refuseOauthOnInferenceTokens: true, dropOld: true });
    } catch (error) {
      baseline?.server.close();
      t.skip(`cannot listen on 127.0.0.1 here: ${error.message}`);
      return;
    }
    try {
      const dir = await mkdtemp(join(tmpdir(), 'access-diff-'));
      const credentials = join(dir, 'credentials.json');
      await writeFile(
        credentials,
        JSON.stringify({
          baseline: { apiToken: 'opf_baselinetoken1', oauthApi: 'opfo_baselineoauth1' },
          candidate: { apiToken: 'opf_candidatetoken1', oauthApi: 'opfo_candidateoauth1' },
        })
      );
      const empty = join(dir, 'empty.json');
      await writeFile(empty, JSON.stringify({ approvals: [] }));
      const noProbes = join(dir, 'probes.json');
      await writeFile(noProbes, JSON.stringify({ probes: [] }));
      const common = ['--baseline', baseline.url, '--candidate', candidate.url, '--credentials', credentials, '--probes', noProbes, '--no-mcp'];

      const failed = await runCli([...common, '--out', join(dir, 'out1'), '--approved', empty]);
      assert.equal(failed.code, 1, failed.stderr);
      const diff = await readFile(join(dir, 'out1', 'diff.md'), 'utf8');
      const narrowedSection = diff.slice(diff.indexOf('## Narrowed'), diff.indexOf('## Removed'));
      assert.match(narrowedSection, /POST \/api\/inference\/tokens \| oauthApi \| validation 400 VALIDATION_ERROR/);
      assert.doesNotMatch(narrowedSection, /apiToken \|/);
      assert.match(diff.slice(diff.indexOf('## Removed')), /GET \/api\/old/);
      assert.ok(diff.indexOf('## Narrowed') < diff.indexOf('## Widened'));
      const rowsJson = await readFile(join(dir, 'out1', 'rows.json'), 'utf8');
      assert.doesNotMatch(rowsJson, /baselinetoken1|candidateoauth1/);
      assert.ok(!candidate.seen.some((request) => request.path === '/api/system/restart'));
      assert.ok(candidate.seen.some((request) => request.path === `/api/nodes/${FAKE_UUID}`));

      const approved = join(dir, 'approved.json');
      await writeFile(
        approved,
        JSON.stringify({
          approvals: [
            { route: 'POST /api/inference/tokens', credential: 'oauthApi', reason: 'test', approvedBy: 'owner', date: '2026-10-31' },
            { route: 'GET /api/old', credential: '*', reason: 'test', approvedBy: 'owner', date: '2026-10-31' },
          ],
        })
      );
      const passed = await runCli([...common, '--out', join(dir, 'out2'), '--approved', approved]);
      assert.equal(passed.code, 0, passed.stderr);
      assert.match(passed.stdout, /^PASS/);
    } finally {
      baseline.server.close();
      candidate.server.close();
    }
  });
});
