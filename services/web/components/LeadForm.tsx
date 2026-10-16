'use client';

import { useState } from 'react';
import type { SearchFilters } from '@/lib/types';

const CONSENT =
  'By submitting, you agree to receive calls and texts, including automated texts, about real estate from this office at the number provided. Consent is not a condition of purchase. Msg & data rates may apply. Reply STOP to opt out.';

interface Props {
  office: string;
  listingId?: string;
  savedSearch?: { name: string; query_text?: string; filters: SearchFilters };
  cta: string;
  onDone?: () => void;
}

export default function LeadForm({ office, listingId, savedSearch, cta, onDone }: Props) {
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ agent_first_name: string | null; texting: boolean; phone: string } | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setState('sending');
    const body = {
      first_name: String(form.get('first_name') ?? ''),
      last_name: String(form.get('last_name') ?? '') || undefined,
      phone: String(form.get('phone') ?? ''),
      email: String(form.get('email') ?? '') || undefined,
      message: String(form.get('message') ?? '') || undefined,
      consent_sms: form.get('consent') === 'on',
      listing_id: listingId,
      saved_search: savedSearch,
    };
    const res = await fetch(`/api/v1/t/${office}/leads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setState('error');
      setError(json.message ?? (Array.isArray(json.issues) ? json.issues.map((i: { message: string }) => i.message).join(', ') : 'Something went wrong'));
      return;
    }
    setResult({ agent_first_name: json.agent_first_name, texting: json.texting, phone: body.phone });
    setState('done');
    onDone?.();
  }

  if (state === 'done' && result) {
    return (
      <div className="rounded-xl bg-accent-soft p-4" role="status">
        <p className="font-semibold">Thanks! {result.agent_first_name ? `${result.agent_first_name} has your request.` : 'Your request is in.'}</p>
        <p className="mt-1 text-sm text-ink2">
          {result.texting ? `You'll get a text at ${result.phone} in a few seconds.` : 'An agent will be in touch by email.'}
        </p>
        {result.texting && (
          <a className="mt-2 inline-block text-sm font-semibold text-accent underline" href={`/console/phone?handset=${encodeURIComponent(result.phone)}`}>
            Open the sandbox phone
          </a>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <input className="input" name="first_name" placeholder="First name" required autoComplete="given-name" />
        <input className="input" name="last_name" placeholder="Last name" autoComplete="family-name" />
      </div>
      <input className="input" name="phone" placeholder="Mobile, e.g. (202) 555-0199" required inputMode="tel" autoComplete="tel" />
      <input className="input" name="email" type="email" placeholder="Email (optional)" autoComplete="email" />
      {listingId && <textarea className="input" name="message" rows={2} placeholder="Question for the agent (optional)" defaultValue="Is this one still available?" />}
      <label className="flex gap-2 text-xs leading-snug text-ink2">
        <input type="checkbox" name="consent" defaultChecked className="mt-0.5 h-4 w-4 flex-none accent-[var(--accent)]" />
        <span>{CONSENT}</span>
      </label>
      {state === 'error' && <p className="text-sm text-bad">{error}</p>}
      <button className="btn w-full" disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending…' : cta}
      </button>
      <p className="text-[11px] text-muted">Sandbox: only fictional 555-01xx numbers receive texts.</p>
    </form>
  );
}
