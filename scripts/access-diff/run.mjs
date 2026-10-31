#!/usr/bin/env node
// Compares what every kind of credential may do on two Opfield installations (the last stable and a candidate).
// See README.md in this folder.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CREDENTIAL_KINDS,
  credentialSecrets,
  Installation,
  parseInstallationCredentials,
  redact,
} from './lib/client.mjs';
import { callMcpTool, initializeMcp, listMcpTools } from './lib/mcp.mjs';
import { classifyMcp, classifyRest, classifyRow, evaluateGate, parseApprovals } from './lib/outcome.mjs';
import { FAKE_UUID, planMcpProbes, planRestProbes } from './lib/plan.mjs';
import { renderDiff } from './lib/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDES = ['baseline', 'candidate'];
const REST_SANITY_ORDER = ['apiToken', 'session', 'oauthApi', 'impersonation', 'apiTokenNarrow'];

const USAGE = `Usage: node scripts/access-diff/run.mjs --baseline <url> --candidate <url> --credentials <file.json> --out <dir>
Options:
  --approved <file>     approved narrowings (default: approved.json beside this script)
  --probes <file>       extra deep probes (default: probes.json beside this script)
  --concurrency <n>     parallel requests per installation (default 4)
  --timeout <ms>        per-request timeout (default 15000)
  --reserve <0..1>      share of each rate-limit window left untouched for other clients (default 0.25)
  --only <regex>        probe only routes matching the regex (quick checks; the gate then covers only those)
  --no-mcp              skip MCP probes
  --strict              also fail on inconclusive rows
  --insecure            accept self-signed TLS certificates`;

function fail(message, code = 2) {
  process.stderr.write(`access-diff: ${message}\n`);
  process.exit(code);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        baseline: { type: 'string' },
        candidate: { type: 'string' },
        credentials: { type: 'string' },
        out: { type: 'string' },
        approved: { type: 'string', default: join(HERE, 'approved.json') },
        probes: { type: 'string', default: join(HERE, 'probes.json') },
        concurrency: { type: 'string', default: '4' },
        timeout: { type: 'string', default: '15000' },
        reserve: { type: 'string', default: '0.25' },
        only: { type: 'string' },
        'no-mcp': { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        insecure: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (error) {
    fail(`${error.message}\n${USAGE}`);
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  for (const name of ['baseline', 'candidate', 'credentials', 'out']) {
    if (!parsed[name]) fail(`--${name} is required\n${USAGE}`);
  }
  const concurrency = Number(parsed.concurrency);
  const timeoutMs = Number(parsed.timeout);
  const reserve = Number(parsed.reserve);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) fail('--concurrency must be 1..32');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) fail('--timeout must be at least 1000');
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= 1) fail('--reserve must be in [0, 1)');
  return { ...parsed, concurrency, timeoutMs, reserve, only: parsed.only ? new RegExp(parsed.only) : null };
}

async function readJson(path, { optional = false } = {}) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    fail(`cannot read ${path}: ${error.message}`);
  }
}

async function pool(tasks, concurrency) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      await tasks[index]();
    }
  });
  await Promise.all(workers);
}

async function sanityCheck(installation, credential) {
  if (credential.type === 'none') return { ok: true, note: 'n/a' };
  if (credential.id === 'oauthMcp') {
    const init = await initializeMcp(installation, credential);
    installation.mcpInit.set(credential.id, init);
    return init.ok
      ? { ok: true, note: 'ok (MCP initialize)' }
      : { ok: false, note: `MCP initialize refused: ${classifyMcp(init.response)} ${init.response.httpStatus ?? ''}` };
  }
  if (credential.id === 'inferenceKey') {
    const result = await installation.rest(credential, 'GET', '/api/inference/v1/models', { Accept: 'application/json' });
    return result.status === 200
      ? { ok: true, note: 'ok (GET /api/inference/v1/models)' }
      : { ok: false, note: `GET /api/inference/v1/models answered ${result.status ?? result.error}` };
  }
  const result = await installation.raw(credential, 'GET', '/health', { Accept: 'application/json' }, undefined, {
    readBody: true,
  });
  let version = null;
  try {
    version = JSON.parse(result.text ?? '{}').version ?? null;
  } catch {}
  if (version) {
    installation.version ??= version;
    return { ok: true, note: 'ok' };
  }
  return { ok: false, note: `not signed in on GET /health (${result.status ?? result.error})` };
}

function sideRecord(outcome, response, request, secrets) {
  return {
    outcome,
    status: response.status ?? response.httpStatus ?? null,
    code: response.code ?? null,
    message: redact(response.message ?? response.rpcError?.message ?? response.text ?? null, secrets)?.slice?.(0, 300) ?? null,
    error: response.error ?? null,
    durationMs: response.durationMs ?? null,
    ...(response.inherited ? { inherited: response.inherited } : {}),
    request,
  };
}

function redactedRequestHeaders(credential, headers, method) {
  const out = { ...headers };
  if (credential.type === 'bearer') out.Authorization = 'Bearer [redacted]';
  if (credential.type === 'session') {
    out.Cookie = '[redacted]';
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) out['X-CSRF-Token'] = '[redacted]';
  }
  return out;
}

function validateDeepProbes(document) {
  if (!document) return [];
  const list = Array.isArray(document.probes) ? document.probes : null;
  if (!list) fail('probes.json must be {"probes": [...]}');
  const ids = new Set();
  return list.map((probe, index) => {
    const where = `probes[${index}]`;
    if (typeof probe.id !== 'string' || !probe.id) fail(`${where}.id is required`);
    if (ids.has(probe.id)) fail(`${where}.id "${probe.id}" is not unique`);
    ids.add(probe.id);
    // The one safety rail a curated probe must keep: it points at the non-existent id, so it cannot act on anything.
    if (!JSON.stringify(probe).includes(FAKE_UUID)) fail(`${where} (${probe.id}) must reference ${FAKE_UUID}`);
    if (probe.kind === 'rest') {
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(probe.method ?? '') || !String(probe.path ?? '').startsWith('/')) {
        fail(`${where} needs method and path`);
      }
    } else if (probe.kind === 'mcp') {
      if (typeof probe.tool !== 'string' || !probe.arguments || typeof probe.arguments !== 'object') {
        fail(`${where} needs tool and arguments`);
      }
    } else {
      fail(`${where}.kind must be "rest" or "mcp"`);
    }
    return probe;
  });
}

async function main() {
  const cli = parseCli();
  if (cli.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const startedAt = new Date().toISOString();
  const log = (line) => process.stderr.write(`${line}\n`);

  const credentialsFile = await readJson(resolve(cli.credentials));
  const approvalsDocument = (await readJson(resolve(cli.approved), { optional: true })) ?? { approvals: [] };
  const { approvals, problems: approvalProblems } = parseApprovals(approvalsDocument);
  if (approvalProblems.length) fail(`approved.json:\n  ${approvalProblems.join('\n  ')}`);
  const deepProbes = validateDeepProbes(await readJson(resolve(cli.probes), { optional: true }));

  const installations = {};
  const credentialsBySide = {};
  const secrets = [];
  for (const side of SIDES) {
    const parsed = parseInstallationCredentials(credentialsFile?.[side]);
    if (parsed.problems.length) fail(`credentials.${side}:\n  ${parsed.problems.join('\n  ')}`);
    credentialsBySide[side] = parsed;
    for (const credential of parsed.credentials) secrets.push(...credentialSecrets(credential));
    const installation = new Installation(side, cli[side], {
      timeoutMs: cli.timeoutMs,
      reserve: cli.reserve,
      maxRetries: 5,
      log,
      onSecret: (value) => {
        if (typeof value === 'string' && value.length >= 6) secrets.push(value);
      },
    });
    installation.mcpInit = new Map();
    installation.version = null;
    installations[side] = installation;
  }

  // Credentials present on both sides are compared; the rest are reported.
  const ids = [
    'anonymous',
    ...CREDENTIAL_KINDS.map((kind) => kind.id),
    ...new Set(SIDES.flatMap((side) => credentialsBySide[side].credentials.map((credential) => credential.id))),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const credentialTable = [];
  const compared = [];
  for (const id of ids) {
    const bySide = Object.fromEntries(
      SIDES.map((side) => [side, credentialsBySide[side].credentials.find((credential) => credential.id === id) ?? null])
    );
    const label =
      bySide.baseline?.label ?? bySide.candidate?.label ?? CREDENTIAL_KINDS.find((kind) => kind.id === id)?.label ?? id;
    const entry = { id, label, baseline: 'missing', candidate: 'missing', sanity: {} };
    for (const side of SIDES) {
      if (!bySide[side]) continue;
      const sanity = await sanityCheck(installations[side], bySide[side]);
      entry.sanity[side] = sanity.ok;
      entry[side] = sanity.note;
    }
    credentialTable.push(entry);
    if (!bySide.baseline || !bySide.candidate) {
      log(`credential ${id}: missing on ${!bySide.baseline ? 'baseline' : 'candidate'}${!bySide.baseline && !bySide.candidate ? ' and candidate' : ''}, skipped`);
      continue;
    }
    if (!entry.sanity.baseline && !entry.sanity.candidate) {
      log(`credential ${id}: rejected by both installations, skipped (check the credential)`);
      entry.baseline += ' (skipped)';
      entry.candidate += ' (skipped)';
      continue;
    }
    if (!entry.sanity.baseline || !entry.sanity.candidate) {
      log(`WARNING credential ${id}: rejected by the ${entry.sanity.baseline ? 'candidate' : 'baseline'} only; its rows show that as narrowed/widened. Check the credential is valid there.`);
    }
    compared.push({ id, bySide });
  }

  // The OpenAPI documents, read with the first credential each installation signs in.
  const docs = {};
  for (const side of SIDES) {
    const credential = REST_SANITY_ORDER.map((id) =>
      credentialsBySide[side].credentials.find((c) => c.id === id && credentialTable.find((e) => e.id === id)?.sanity[side])
    ).find(Boolean);
    if (!credential) fail(`${side}: no credential signs in to read /api/openapi.json (need session, apiToken or oauthApi)`);
    const result = await installations[side].raw(credential, 'GET', '/api/openapi.json', { Accept: 'application/json' }, undefined, {
      readBody: true,
      bodyLimit: 64 * 1024 * 1024,
    });
    try {
      docs[side] = JSON.parse(result.text ?? '');
    } catch {
      fail(`${side}: GET /api/openapi.json answered ${result.status ?? result.error} without a JSON document`);
    }
    if (!docs[side]?.paths) fail(`${side}: /api/openapi.json has no paths`);
    log(`${side}: OpenAPI document with ${Object.keys(docs[side].paths).length} paths (read as ${credential.id})`);
  }

  const skipped = [];
  let restProbes = planRestProbes(docs.baseline, docs.candidate);
  if (cli.only) restProbes = restProbes.filter((probe) => cli.only.test(probe.route));
  for (const probe of restProbes) if (probe.request.skip) skipped.push({ route: probe.route, reason: probe.request.skip });

  // MCP: initialize per credential, then the union of the tool lists of every credential that got in.
  let mcpProbes = [];
  const mcpCredentials = [];
  if (!cli['no-mcp']) {
    const toolsBySide = { baseline: new Map(), candidate: new Map() };
    for (const { id, bySide } of compared) {
      let anyOk = false;
      for (const side of SIDES) {
        const installation = installations[side];
        const init = installation.mcpInit.get(id) ?? (await initializeMcp(installation, bySide[side]));
        installation.mcpInit.set(id, init);
        if (!init.ok) continue;
        anyOk = true;
        const listed = await listMcpTools(installation, bySide[side], init.sessionId);
        if (listed.error) log(`${side}: tools/list as ${id} failed: ${listed.error}`);
        init.tools = new Set(listed.tools.map((tool) => tool.name));
        for (const tool of listed.tools) if (!toolsBySide[side].has(tool.name)) toolsBySide[side].set(tool.name, tool);
      }
      if (anyOk) mcpCredentials.push(id);
    }
    mcpProbes = planMcpProbes(toolsBySide.baseline, toolsBySide.candidate);
    if (cli.only) mcpProbes = mcpProbes.filter((probe) => cli.only.test(probe.route));
    for (const probe of mcpProbes) if (probe.request.skip) skipped.push({ route: probe.route, reason: probe.request.skip });
    log(`MCP: ${mcpProbes.length} tools, probed as ${mcpCredentials.join(', ') || 'no credential (none got in)'}`);
  }

  // Runs every probe on both installations.
  const rows = [];
  const tasks = { baseline: [], candidate: [] };
  const addRow = (row) => {
    rows.push(row);
    return row;
  };

  for (const probe of restProbes) {
    for (const { id, bySide } of compared) {
      const row = addRow({ kind: 'rest', route: probe.route, credential: id, inBaseline: probe.inBaseline, inCandidate: probe.inCandidate, baseline: null, candidate: null });
      if (probe.request.skip) continue;
      for (const side of SIDES) {
        tasks[side].push(async () => {
          const credential = bySide[side];
          const response = await installations[side].rest(credential, probe.method, probe.request.path, probe.request.headers, probe.request.body);
          row[side] = sideRecord(classifyRest(response), response, {
            method: probe.method,
            path: probe.request.path,
            headers: redactedRequestHeaders(credential, probe.request.headers, probe.method),
            ...(probe.request.body !== undefined ? { body: probe.request.body } : {}),
          }, secrets);
        });
      }
    }
  }

  if (!cli['no-mcp']) {
    for (const { id } of compared) {
      const row = addRow({ kind: 'mcp', route: 'MCP initialize', credential: id, inBaseline: true, inCandidate: true, baseline: null, candidate: null });
      for (const side of SIDES) {
        const init = installations[side].mcpInit.get(id);
        row[side] = sideRecord(classifyMcp(init.response), init.response, { method: 'initialize' }, secrets);
      }
    }
    const mcpCall = (probe, id, bySide, row, args) => {
      for (const side of SIDES) {
        const init = installations[side].mcpInit.get(id);
        if (!init.ok) {
          // The credential does not get into MCP on this side: every tool is refused as initialize was.
          row[side] = sideRecord(classifyMcp(init.response), { ...init.response, inherited: 'initialize' }, { tool: probe.tool, arguments: args }, secrets);
          continue;
        }
        tasks[side].push(async () => {
          const response = await callMcpTool(installations[side], bySide[side], init.sessionId, probe.tool, args);
          row[side] = sideRecord(classifyMcp(response), response, { tool: probe.tool, arguments: args }, secrets);
        });
      }
    };
    for (const probe of mcpProbes) {
      for (const { id, bySide } of compared.filter((entry) => mcpCredentials.includes(entry.id))) {
        const row = addRow({ kind: 'mcp', route: probe.route, credential: id, inBaseline: probe.inBaseline, inCandidate: probe.inCandidate, baseline: null, candidate: null });
        if (probe.request.skip) continue;
        mcpCall(probe, id, bySide, row, probe.request.arguments);
      }
    }
    for (const probe of deepProbes.filter((entry) => entry.kind === 'mcp')) {
      const route = `PROBE ${probe.id}`;
      if (cli.only && !cli.only.test(route)) continue;
      for (const { id, bySide } of compared.filter((entry) => mcpCredentials.includes(entry.id))) {
        const row = addRow({ kind: 'mcp-probe', route, note: probe.note, credential: id, inBaseline: true, inCandidate: true, baseline: null, candidate: null });
        mcpCall(probe, id, bySide, row, probe.arguments);
      }
    }
  }

  for (const probe of deepProbes.filter((entry) => entry.kind === 'rest')) {
    const route = `PROBE ${probe.id}`;
    if (cli.only && !cli.only.test(route)) continue;
    const body = probe.body === undefined ? undefined : typeof probe.body === 'string' ? probe.body : JSON.stringify(probe.body);
    const headers = { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    for (const { id, bySide } of compared) {
      const row = addRow({ kind: 'rest-probe', route, note: probe.note, credential: id, inBaseline: true, inCandidate: true, baseline: null, candidate: null });
      for (const side of SIDES) {
        tasks[side].push(async () => {
          const response = await installations[side].rest(bySide[side], probe.method, probe.path, headers, body);
          row[side] = sideRecord(classifyRest(response), response, {
            method: probe.method,
            path: probe.path,
            headers: redactedRequestHeaders(bySide[side], headers, probe.method),
            ...(body !== undefined ? { body } : {}),
          }, secrets);
        });
      }
    }
  }

  log(`probing: ${tasks.baseline.length} requests on the baseline, ${tasks.candidate.length} on the candidate`);
  let done = 0;
  const total = tasks.baseline.length + tasks.candidate.length;
  const progress = setInterval(() => log(`  ${done}/${total}`), 15_000);
  const counted = (list) => list.map((task) => async () => { await task(); done += 1; });
  await Promise.all(SIDES.map((side) => pool(counted(tasks[side]), cli.concurrency)));
  clearInterval(progress);

  for (const row of rows) {
    row.class = classifyRow({
      baseline: row.baseline?.outcome ?? null,
      candidate: row.candidate?.outcome ?? null,
      inBaseline: row.inBaseline,
      inCandidate: row.inCandidate,
    });
    if (row.class === 'removed') {
      row.removedReason = !row.inCandidate ? 'not in the candidate OpenAPI document / tool list' : 'candidate does not serve it';
    }
  }

  // How OAuth refreshes went, per side.
  for (const entry of credentialTable) {
    for (const side of SIDES) {
      const credential = credentialsBySide[side].credentials.find((c) => c.id === entry.id);
      const state = credential?.refreshState;
      if (!state) continue;
      if (state.failure) entry[side] += ` (refresh failed: ${state.failure})`;
      else if (state.refreshes) entry[side] += ` (refreshed ${state.refreshes}x)`;
    }
  }

  const gate = evaluateGate(rows, approvals, { strict: cli.strict });
  const meta = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseline: { url: installations.baseline.baseUrl, version: installations.baseline.version },
    candidate: { url: installations.candidate.baseUrl, version: installations.candidate.version },
    requests: installations.baseline.requestCount + installations.candidate.requestCount,
    strict: cli.strict,
    only: cli.only ? String(cli.only) : null,
  };

  await mkdir(resolve(cli.out), { recursive: true });
  const rowsJson = JSON.stringify(
    {
      meta,
      credentials: credentialTable.map(({ sanity, ...entry }) => entry),
      counts: gate.counts,
      failed: gate.failed,
      rows,
    },
    null,
    2
  );
  await writeFile(join(resolve(cli.out), 'rows.json'), redact(rowsJson, secrets));
  await writeFile(join(resolve(cli.out), 'diff.md'), redact(renderDiff({ meta, credentialTable, rows, gate, skipped }), secrets));

  const summary = Object.entries(gate.counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`)
    .join(', ');
  process.stdout.write(
    `${gate.failed ? 'FAIL' : 'PASS'}: ${summary}; ${gate.blocking.length} unapproved narrowed/removed. Report: ${join(resolve(cli.out), 'diff.md')}\n`
  );
  process.exit(gate.failed ? 1 : 0);
}

main().catch((error) => fail(error?.stack ?? String(error)));
