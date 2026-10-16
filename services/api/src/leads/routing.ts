import { Tx } from '../db/db.service';

export interface Candidate {
  id: string;
  recent: number;
  capacity: number;
  lastAssignedAt: Date | null;
}

/**
 * Weighted fallback: the agent with the lowest recent load relative to capacity, ties
 * broken by who was assigned least recently. An agent with capacity 20 takes roughly
 * twice the leads of one with capacity 10.
 */
export function pickByLoad(candidates: Candidate[]): Candidate | null {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => {
    const la = (a.recent + 1) / Math.max(1, a.capacity);
    const lb = (b.recent + 1) / Math.max(1, b.capacity);
    if (la !== lb) return la - lb;
    const ta = a.lastAssignedAt?.getTime() ?? 0;
    const tb = b.lastAssignedAt?.getTime() ?? 0;
    return ta - tb;
  })[0];
}

/**
 * A lead about a listing inside an agent's farm area goes to that agent (the smallest
 * containing farm wins); otherwise to the least-loaded agent in the office.
 */
export async function routeLead(tx: Tx, point: [number, number] | null): Promise<{ agentId: string; reason: string }> {
  if (point) {
    const { rows } = await tx.query(
      `SELECT f.agent_id FROM farm_areas f JOIN agents a ON a.id = f.agent_id
       WHERE a.active AND ST_Contains(f.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
       ORDER BY ST_Area(f.geom) ASC LIMIT 1`,
      point,
    );
    if (rows[0]) {
      await tx.query('UPDATE agents SET last_assigned_at = now() WHERE id = $1', [rows[0].agent_id]);
      return { agentId: rows[0].agent_id, reason: 'farm_area' };
    }
  }
  const { rows } = await tx.query(
    `SELECT a.id, a.capacity, a.last_assigned_at,
            (SELECT count(*) FROM contacts c WHERE c.assigned_agent_id = a.id AND c.created_at > now() - interval '7 days') AS recent
     FROM agents a WHERE a.active`,
  );
  const pick = pickByLoad(
    rows.map((r) => ({ id: r.id, recent: Number(r.recent), capacity: r.capacity, lastAssignedAt: r.last_assigned_at })),
  );
  if (!pick) throw new Error('office has no active agents');
  await tx.query('UPDATE agents SET last_assigned_at = now() WHERE id = $1', [pick.id]);
  return { agentId: pick.id, reason: 'load_balanced' };
}
