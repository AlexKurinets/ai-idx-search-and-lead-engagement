import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { config } from '../config';
import { SearchFilters } from '../search/filters';

export interface ParseResult {
  filters: SearchFilters;
  parser: 'rules' | 'rules+model';
  coverage: number;
  notices: string[];
  unresolved: string[];
  model: string | null;
}

export interface DraftResult {
  body: string;
  ok: boolean;
  attempts: number;
  model: string;
  validation: { numbers: { text: string; value: number; matched: boolean }[]; unmatched: string[]; fair_housing: string[] };
}

export interface ScoreInput {
  contact_id: string;
  stage: string;
  opted_out: boolean;
  has_upcoming_appointment: boolean;
  conversation_status: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  new_matches_7d: number;
  saved_searches: number;
  events: { kind: string; at: string; intent?: string | null }[];
}

export interface ScoreResult {
  contact_id: string;
  score: number;
  band: string;
  components: Record<string, number>;
  next_action: string;
  next_action_reason: string;
}

@Injectable()
export class AiClient {
  private async post<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${config.aiUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ServiceUnavailableException(`AI service unavailable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ServiceUnavailableException(`AI service ${path} returned ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  parseSearch(q: string, previous: SearchFilters | null, markets: string[]): Promise<ParseResult> {
    return this.post('/v1/search/parse', { q, previous, markets });
  }

  draftReport(payload: Record<string, unknown>): Promise<DraftResult> {
    return this.post('/v1/reports/draft', payload, 30_000);
  }

  validateReport(body: string, stats: Record<string, unknown>, extraAllowed: string[] = []): Promise<DraftResult['validation'] & { ok: boolean }> {
    return this.post('/v1/reports/validate', { body, stats, extra_allowed: extraAllowed });
  }

  computeScores(contacts: ScoreInput[], now = new Date()): Promise<{ scores: ScoreResult[] }> {
    return this.post('/v1/scores/compute', { now: now.toISOString(), contacts }, 30_000);
  }

  nlSearchEval(): Promise<Record<string, unknown>> {
    return this.post('/v1/eval/nl-search', {}, 60_000);
  }
}
