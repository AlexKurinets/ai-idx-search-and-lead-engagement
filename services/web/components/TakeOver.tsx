'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function TakeOver({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const owned = status === 'agent_owned' || status === 'handed_off';

  async function takeover() {
    setBusy(true);
    await fetch(`/api/v1/console/conversations/${id}/takeover`, { method: 'POST' });
    setBusy(false);
    router.refresh();
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    await fetch(`/api/v1/console/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: text.trim() }),
    });
    setText('');
    setBusy(false);
    router.refresh();
  }

  if (status === 'ai_active') {
    return (
      <button type="button" className="btn w-full" onClick={takeover} disabled={busy}>
        Take over from the texting engine
      </button>
    );
  }
  if (!owned) return null;
  return (
    <form onSubmit={send} className="flex gap-2">
      <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply as the agent" maxLength={306} />
      <button className="btn flex-none" disabled={busy}>Send</button>
    </form>
  );
}
