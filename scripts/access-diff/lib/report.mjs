// diff.md from the classified rows. Pure: no I/O.

function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A short description of one side of a row: outcome, status and error code. */
export function describeSide(side) {
  if (!side) return 'not probed';
  const parts = [side.outcome];
  if (side.status !== undefined && side.status !== null) parts.push(String(side.status));
  if (side.code) parts.push(side.code);
  if (side.error) parts.push(side.error);
  const message = side.message ? `: ${String(side.message).slice(0, 120)}` : '';
  return `${parts.join(' ')}${message}`;
}

function table(rows, { approval = false } = {}) {
  const header = approval
    ? '| Route | Credential | Baseline | Candidate | Approved (by, date: reason) |\n|---|---|---|---|---|'
    : '| Route | Credential | Baseline | Candidate |\n|---|---|---|---|';
  const lines = rows.map((row) => {
    const base = `| ${cell(row.route)} | ${cell(row.credential)} | ${cell(describeSide(row.baseline))} | ${cell(describeSide(row.candidate))} |`;
    return approval
      ? `${base} ${cell(`${row.approval.approvedBy}, ${row.approval.date}: ${row.approval.reason}`)} |`
      : base;
  });
  return [header, ...lines].join('\n');
}

/** Removed rows of every credential of one route fold into one line. */
function removedTable(rows) {
  const byRoute = new Map();
  for (const row of rows) {
    const entry = byRoute.get(row.route) ?? { route: row.route, credentials: [], reason: row.removedReason };
    entry.credentials.push(row.credential);
    byRoute.set(row.route, entry);
  }
  const lines = [...byRoute.values()].map(
    (entry) => `| ${cell(entry.route)} | ${cell(entry.credentials.join(', '))} | ${cell(entry.reason)} |`
  );
  return ['| Route | Credentials | Why |\n|---|---|---|', ...lines].join('\n');
}

/**
 * @param {{meta: object, credentialTable: Array<object>, rows: Array<object>, gate: object, skipped: Array<object>}} input
 */
export function renderDiff({ meta, credentialTable, rows, gate, skipped }) {
  const out = [];
  out.push('# Access diff');
  out.push('');
  out.push(`- Baseline: ${meta.baseline.url} (${meta.baseline.version ?? 'version unknown'})`);
  out.push(`- Candidate: ${meta.candidate.url} (${meta.candidate.version ?? 'version unknown'})`);
  out.push(`- Run: ${meta.startedAt} → ${meta.finishedAt}, ${meta.requests} requests`);
  out.push(
    `- Result: ${gate.failed ? `**FAIL** (${gate.blocking.length} unapproved narrowed/removed${meta.strict && gate.inconclusive.length ? `, ${gate.inconclusive.length} inconclusive in strict mode` : ''})` : '**PASS**'}`
  );
  out.push('');

  out.push('## Credentials');
  out.push('');
  out.push('| Credential | Baseline | Candidate |\n|---|---|---|');
  for (const entry of credentialTable) {
    out.push(`| ${cell(`${entry.id} (${entry.label})`)} | ${cell(entry.baseline)} | ${cell(entry.candidate)} |`);
  }
  out.push('');

  const blockingNarrowed = gate.blocking.filter((row) => row.class === 'narrowed');
  const blockingRemoved = gate.blocking.filter((row) => row.class === 'removed');
  out.push(`## Narrowed, not approved (${blockingNarrowed.length})`);
  out.push('');
  out.push(blockingNarrowed.length ? table(blockingNarrowed) : 'None.');
  out.push('');
  out.push(`## Removed, not approved (${blockingRemoved.length})`);
  out.push('');
  out.push(blockingRemoved.length ? removedTable(blockingRemoved) : 'None.');
  out.push('');

  const approved = rows.filter((row) => row.approval);
  if (approved.length) {
    out.push(`## Approved narrowings and removals (${approved.length})`);
    out.push('');
    out.push(table(approved, { approval: true }));
    out.push('');
  }

  out.push(`## Inconclusive (${gate.inconclusive.length})`);
  out.push('');
  out.push(
    gate.inconclusive.length
      ? `One side gave no usable answer (timeout, 5xx, network, rate limit). ${meta.strict ? 'Strict mode: these fail the run.' : 'Re-run, or pass --strict to fail on them.'}\n\n${table(gate.inconclusive)}`
      : 'None.'
  );
  out.push('');

  const widened = rows.filter((row) => row.class === 'widened');
  out.push(`## Widened (${widened.length})`);
  out.push('');
  out.push(widened.length ? table(widened) : 'None.');
  out.push('');

  const added = rows.filter((row) => row.class === 'added');
  if (added.length) {
    const routes = [...new Set(added.map((row) => row.route))];
    out.push(`## Added (${routes.length} routes)`);
    out.push('');
    out.push(routes.map((route) => `- ${route}`).join('\n'));
    out.push('');
  }

  out.push('## Counts');
  out.push('');
  out.push('| Class | Rows |\n|---|---|');
  for (const [name, count] of Object.entries(gate.counts)) out.push(`| ${name} | ${count} |`);
  out.push('');

  if (gate.unusedApprovals.length) {
    out.push('## Approvals that matched nothing');
    out.push('');
    out.push(
      gate.unusedApprovals.map((approval) => `- ${approval.route} / ${approval.credential} (${approval.date})`).join('\n')
    );
    out.push('');
  }

  if (skipped.length) {
    out.push('## Not probed');
    out.push('');
    out.push('| Route | Why |\n|---|---|');
    for (const entry of skipped) out.push(`| ${cell(entry.route)} | ${cell(entry.reason)} |`);
    out.push('');
  }
  return `${out.join('\n')}\n`;
}
