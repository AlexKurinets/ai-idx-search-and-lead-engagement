'use client';

import { useEffect, useRef, useState } from 'react';

interface Sms {
  id: number;
  direction: 'to_handset' | 'from_handset';
  body: string;
  brokerage_number: string;
  created_at: string;
  office: string | null;
}

interface Handset {
  handset: string;
  brokerage_number: string;
  last_body: string;
  last_at: string;
  office: string | null;
}

/**
 * A pretend phone. Texts the office sends land here; what you type is posted to the
 * real inbound webhook with a valid provider signature, so the reply takes the same
 * path a real SMS would.
 */
export default function Phone({ initial }: { initial?: string }) {
  const [handset, setHandset] = useState(initial ?? '');
  const [input, setInput] = useState(initial ?? '');
  const [messages, setMessages] = useState<Sms[]>([]);
  const [recent, setRecent] = useState<Handset[]>([]);
  const [text, setText] = useState('');
  const last = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/sandbox/handsets').then((r) => r.json()).then((rows: Handset[]) => setRecent(rows.sort((a, b) => b.last_at.localeCompare(a.last_at)).slice(0, 12))).catch(() => undefined);
  }, [handset]);

  useEffect(() => {
    if (!handset) return;
    last.current = 0;
    setMessages([]);
    let stop = false;
    const tick = async () => {
      const r = await fetch(`/api/sandbox/handsets/${encodeURIComponent(handset)}/messages?after=${last.current}`).catch(() => null);
      if (r?.ok) {
        const rows = (await r.json()) as Sms[];
        if (rows.length) {
          last.current = rows[rows.length - 1].id;
          setMessages((m) => [...m, ...rows]);
        }
      }
      if (!stop) setTimeout(tick, 1200);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [handset]);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [messages.length]);

  const officeNumber = messages.length ? messages[messages.length - 1].brokerage_number : recent.find((h) => h.handset === handset)?.brokerage_number;
  const office = messages.find((m) => m.office)?.office;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !officeNumber) return;
    await fetch(`/api/sandbox/handsets/${encodeURIComponent(handset)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: officeNumber, body: text.trim() }),
    });
    setText('');
  }

  return (
    <div className="grid gap-6 md:grid-cols-[380px_1fr]">
      <div className="mx-auto w-full max-w-[380px]">
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const digits = input.replace(/\D/g, '');
            setHandset(digits.length === 10 ? `+1${digits}` : `+${digits}`);
          }}
        >
          <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Handset number, e.g. (202) 555-0199" aria-label="Handset number" />
          <button className="btn-ghost flex-none">Open</button>
        </form>
        <div className="overflow-hidden rounded-[2rem] border-[6px] border-[var(--ink)] bg-surface shadow-xl">
          <div className="border-b border-line px-4 py-3 text-center">
            <p className="text-sm font-semibold">{office ?? 'Messages'}</p>
            <p className="text-[11px] text-muted">{officeNumber ?? 'No messages yet'} · to {handset || '…'}</p>
          </div>
          <div className="h-[460px] space-y-2 overflow-y-auto px-3 py-3" data-testid="phone-thread">
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.direction === 'from_handset' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.direction === 'from_handset' ? 'bg-accent text-accent-ink' : 'bg-page text-ink'}`}>
                  {m.body}
                  <p className={`mt-0.5 text-[10px] ${m.direction === 'from_handset' ? 'opacity-80' : 'text-muted'}`}>
                    {new Date(m.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
                  </p>
                </div>
              </div>
            ))}
            {handset && messages.length === 0 && <p className="pt-10 text-center text-sm text-muted">Waiting for a text…</p>}
            <div ref={bottom} />
          </div>
          <form onSubmit={send} className="flex gap-2 border-t border-line p-2">
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Text message" disabled={!officeNumber} aria-label="Message" />
            <button className="btn flex-none" disabled={!officeNumber}>Send</button>
          </form>
        </div>
      </div>
      <div>
        <h2 className="font-semibold">Recent sandbox handsets</h2>
        <ul className="mt-2 space-y-1">
          {recent.map((h) => (
            <li key={h.handset}>
              <button type="button" className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface" onClick={() => { setInput(h.handset); setHandset(h.handset); }}>
                <span className="font-medium tabular">{h.handset}</span> <span className="text-muted">· {h.office}</span>
                <span className="block truncate text-xs text-ink2">{h.last_body}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
