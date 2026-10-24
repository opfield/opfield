import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type Finding = {
  id: number;
  severity: Severity;
  /** The generic invariant that broke, e.g. `no-5xx`, `crud-readback`, `async-terminal`. */
  invariant: string;
  title: string;
  phase: string;
  request?: { method: string; path: string; body?: string };
  response?: { status: number; excerpt: string };
  detail?: string;
  repro: string;
  at: string;
};

export type CoverageStatus = 'exercised' | 'skipped' | 'failed';

export type CoverageEntry = {
  operation: string;
  status: CoverageStatus;
  checks: string[];
  reason?: string;
};

export type PhaseTiming = {
  phase: string;
  startedAt: string;
  ms: number;
  status: 'ok' | 'failed' | 'skipped';
  note?: string;
};

const SECRET_KEY =
  /(secret|password|passwd|token|apikey|api_key|private|credential|accesskey|access_key|authorization|cookie|connectionuri|dsn)/i;

/** Masks secret-looking values before anything reaches a report or the console. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) && item !== null && typeof item !== 'object' && typeof item !== 'boolean'
          ? '<redacted>'
          : redact(item, depth + 1),
      ])
    );
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

export function redactText(text: string) {
  return text
    .replace(/(gw_|opf_|ofp_|pat_|glpat-)[A-Za-z0-9_-]{8,}/g, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/(postgres(?:ql)?|redis|s3|https?):\/\/([^:@/\s]+):([^@/\s]+)@/gi, '$1://$2:<redacted>@')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted private key>');
}

export function excerpt(body: unknown, text: string, max = 600) {
  const raw = body && typeof body === 'object' ? JSON.stringify(redact(body)) : redactText(text ?? '');
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

export class Report {
  readonly findings: Finding[] = [];
  readonly coverage = new Map<string, CoverageEntry>();
  readonly phases: PhaseTiming[] = [];
  readonly notes: string[] = [];
  readonly startedAt = new Date();
  private readonly dedupe = new Set<string>();
  currentPhase = 'setup';

  constructor(
    readonly seed: string,
    readonly target: string,
    readonly phasesLabel: string
  ) {}

  repro() {
    return `SEED=${this.seed} PHASES=${this.phasesLabel} pnpm --filter backend e2e:matrix`;
  }

  /** Adds a finding once per dedupe key (defaults to invariant + title). Returns false for a duplicate. */
  add(finding: Omit<Finding, 'id' | 'at' | 'repro' | 'phase'> & { phase?: string; dedupeKey?: string }) {
    const key = finding.dedupeKey ?? `${finding.invariant}|${finding.title}`;
    if (this.dedupe.has(key)) return false;
    this.dedupe.add(key);
    const { dedupeKey: _ignored, ...rest } = finding;
    const phase = finding.phase ?? this.currentPhase;
    const entry: Finding = {
      ...rest,
      phase,
      id: this.findings.length + 1,
      at: new Date().toISOString(),
      repro: this.repro(),
    };
    this.findings.push(entry);
    console.log(`  ! [${entry.severity}] ${entry.invariant}: ${entry.title}`);
    return true;
  }

  cover(operation: string, status: CoverageStatus, check?: string, reason?: string) {
    const existing = this.coverage.get(operation);
    if (!existing) {
      this.coverage.set(operation, { operation, status, checks: check ? [check] : [], reason });
      return;
    }
    // failed > exercised > skipped: a later success never hides an earlier failure.
    const rank = { skipped: 0, exercised: 1, failed: 2 } as const;
    if (rank[status] > rank[existing.status]) {
      existing.status = status;
      if (reason) existing.reason = reason;
    } else if (status === 'skipped' && existing.status === 'skipped' && reason && !existing.reason) {
      existing.reason = reason;
    }
    if (check && !existing.checks.includes(check)) existing.checks.push(check);
  }

  note(text: string) {
    this.notes.push(text);
    console.log(`  · ${text}`);
  }

  summary() {
    const entries = [...this.coverage.values()];
    const count = (status: CoverageStatus) => entries.filter((entry) => entry.status === status).length;
    const bySeverity = Object.fromEntries(
      (['critical', 'high', 'medium', 'low', 'info'] as const).map((severity) => [
        severity,
        this.findings.filter((finding) => finding.severity === severity).length,
      ])
    );
    return {
      operations: entries.length,
      exercised: count('exercised'),
      failed: count('failed'),
      skipped: count('skipped'),
      findings: this.findings.length,
      bySeverity,
    };
  }

  write(outDir: string, extra: Record<string, unknown> = {}) {
    mkdirSync(outDir, { recursive: true });
    const finishedAt = new Date();
    const summary = this.summary();
    const json = {
      seed: this.seed,
      target: this.target,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      summary,
      phases: this.phases,
      findings: this.findings,
      coverage: [...this.coverage.values()].sort((a, b) => a.operation.localeCompare(b.operation)),
      notes: this.notes,
      ...extra,
    };
    const jsonPath = join(outDir, `matrix-${this.seed}.json`);
    const mdPath = join(outDir, `matrix-${this.seed}.md`);
    writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
    writeFileSync(mdPath, this.markdown(json.durationMs, summary));
    return { jsonPath, mdPath };
  }

  private markdown(durationMs: number, summary: ReturnType<Report['summary']>) {
    const lines: string[] = [];
    const fmt = (ms: number) => `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
    lines.push(`# Opfield surface matrix — seed ${this.seed}`, '');
    lines.push(
      `Target: ${this.target}  `,
      `Started: ${this.startedAt.toISOString()}  `,
      `Duration: ${fmt(durationMs)}`,
      ''
    );
    lines.push('## Summary', '');
    lines.push(
      `- Operations: ${summary.operations} (exercised ${summary.exercised}, failed ${summary.failed}, skipped ${summary.skipped})`
    );
    lines.push(
      `- Findings: ${summary.findings} (${Object.entries(summary.bySeverity)
        .map(([severity, count]) => `${severity} ${count}`)
        .join(', ')})`,
      ''
    );
    lines.push('## Phases', '', '| Phase | Status | Duration | Note |', '| --- | --- | --- | --- |');
    for (const phase of this.phases)
      lines.push(`| ${phase.phase} | ${phase.status} | ${fmt(phase.ms)} | ${phase.note ?? ''} |`);
    lines.push('', '## Findings', '');
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
    for (const finding of [...this.findings].sort((a, b) => order[a.severity] - order[b.severity] || a.id - b.id)) {
      lines.push(`### ${finding.id}. [${finding.severity}] ${finding.title}`, '');
      lines.push(`- Invariant: \`${finding.invariant}\` (phase ${finding.phase})`);
      if (finding.request) {
        lines.push(`- Request: \`${finding.request.method} ${finding.request.path}\``);
        if (finding.request.body) lines.push(`- Body: \`${finding.request.body.replace(/`/g, "'")}\``);
      }
      if (finding.response)
        lines.push(`- Response ${finding.response.status}: \`${finding.response.excerpt.replace(/`/g, "'")}\``);
      if (finding.detail) lines.push(`- Detail: ${finding.detail}`);
      lines.push(`- Repro: \`${finding.repro}\``, '');
    }
    const skipped = [...this.coverage.values()].filter((entry) => entry.status === 'skipped');
    const reasons = new Map<string, number>();
    for (const entry of skipped)
      reasons.set(entry.reason ?? 'unspecified', (reasons.get(entry.reason ?? 'unspecified') ?? 0) + 1);
    lines.push('## Skip reasons', '', '| Reason | Operations |', '| --- | --- |');
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]))
      lines.push(`| ${reason.replace(/\|/g, '/')} | ${count} |`);
    lines.push('', '## Coverage', '', '| Operation | Status | Checks | Reason |', '| --- | --- | --- | --- |');
    for (const entry of [...this.coverage.values()].sort((a, b) => a.operation.localeCompare(b.operation)))
      lines.push(
        `| \`${entry.operation}\` | ${entry.status} | ${entry.checks.join(', ')} | ${(entry.reason ?? '').replace(/\|/g, '/')} |`
      );
    if (this.notes.length) {
      lines.push('', '## Notes', '');
      for (const note of this.notes) lines.push(`- ${note}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
