import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { API_TOKEN_SCOPES } from '../../src/lib/scopes.js';

const GROUP_NAME = 'codex-e2e-api-all-scopes';
const TOKEN_NAME = 'codex-e2e-api-token';
const USER_OIDC_SUBJECT = 'codex-e2e-api-user';
const USER_EMAIL = 'codex-e2e-api-user@gateway.local';

export type SeededToken = {
  token: string;
  tokenId: string;
  userId: string;
  groupId: string;
  scopes: string[];
};

function hashToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

export async function seedApiToken(databaseUrl: string): Promise<{ pool: Pool; seeded: SeededToken }> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const scopes = [...API_TOKEN_SCOPES].sort();
    const groupId = randomUUID();
    const userId = randomUUID();
    const tokenId = randomUUID();
    const token = `opf_${randomBytes(32).toString('hex')}`;

    await client.query('begin');
    const group = await client.query<{ id: string }>(
      `
        insert into permission_groups (id, name, description, is_builtin, scopes, updated_at)
        values ($1, $2, $3, false, $4::jsonb, now())
        on conflict (name) do update
          set scopes = excluded.scopes,
              description = excluded.description,
              updated_at = now()
        returning id
      `,
      [groupId, GROUP_NAME, 'Synthetic all-scope group for local API e2e smoke tests', JSON.stringify(scopes)]
    );

    const resolvedGroupId = group.rows[0]?.id;
    if (!resolvedGroupId) throw new Error('Failed to upsert e2e permission group');

    const user = await client.query<{ id: string }>(
      `
        insert into users (id, oidc_subject, email, name, group_id, is_blocked, updated_at)
        values ($1, $2, $3, $4, $5, false, now())
        on conflict (oidc_subject) do update
          set email = excluded.email,
              name = excluded.name,
              group_id = excluded.group_id,
              is_blocked = false,
              updated_at = now()
        returning id
      `,
      [userId, USER_OIDC_SUBJECT, USER_EMAIL, 'Codex API E2E', resolvedGroupId]
    );

    const resolvedUserId = user.rows[0]?.id;
    if (!resolvedUserId) throw new Error('Failed to upsert e2e user');

    await client.query('delete from api_tokens where user_id = $1 and name = $2', [resolvedUserId, TOKEN_NAME]);
    await client.query(
      `
        insert into api_tokens (id, user_id, name, token_hash, token_prefix, scopes, created_at)
        values ($1, $2, $3, $4, $5, $6::jsonb, now())
      `,
      [tokenId, resolvedUserId, TOKEN_NAME, hashToken(token), token.slice(0, 10), JSON.stringify(scopes)]
    );
    await client.query('commit');

    return {
      pool,
      seeded: { token, tokenId, userId: resolvedUserId, groupId: resolvedGroupId, scopes },
    };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    await pool.end().catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupSeededIdentity(pool: Pool, seeded: Pick<SeededToken, 'tokenId' | 'userId' | 'groupId'>) {
  await pool.query('begin');
  try {
    await pool.query('delete from api_tokens where id = $1', [seeded.tokenId]);
    await pool.query('delete from audit_log where user_id = $1', [seeded.userId]);
    await pool.query('delete from users where id = $1', [seeded.userId]);
    await pool.query('delete from permission_groups where id = $1 and name = $2', [seeded.groupId, GROUP_NAME]);
    await pool.query('commit');
  } catch (error) {
    await pool.query('rollback').catch(() => {});
    throw error;
  }
}
