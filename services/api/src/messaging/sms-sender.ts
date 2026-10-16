import { randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { Db } from '../db/db.service';

export interface SmsSender {
  readonly name: string;
  send(msg: { tenantId: string; from: string; to: string; body: string; idempotencyKey: string }): Promise<{ sid: string }>;
}

/** Records the message in the sandbox carrier table; the sandbox handset reads it from there. */
export class SandboxSmsSender implements SmsSender {
  readonly name = 'sandbox';
  constructor(private readonly db: Db) {}

  async send(msg: { tenantId: string; from: string; to: string; body: string }) {
    const sid = `SM${randomBytes(16).toString('hex')}`;
    await this.db.query(
      `INSERT INTO sandbox_sms (tenant_id, direction, handset, brokerage_number, body, provider_sid)
       VALUES ($1, 'to_handset', $2, $3, $4, $5)`,
      [msg.tenantId, msg.to, msg.from, msg.body, sid],
    );
    return { sid };
  }
}

/**
 * The production adapter: Twilio's Messages API. The idempotency key is already
 * enforced by the unique index on messages before this is called; it is also logged
 * so a provider-side duplicate can be traced.
 */
export class TwilioSmsSender implements SmsSender {
  readonly name = 'twilio';
  private readonly log = new Logger('twilio');
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  async send(msg: { from: string; to: string; body: string; idempotencyKey: string }) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: msg.from, To: msg.to, Body: msg.body }),
    });
    if (!res.ok) throw new Error(`twilio send failed: ${res.status}`);
    const body = (await res.json()) as { sid: string };
    this.log.log(`sent ${body.sid} key=${msg.idempotencyKey}`);
    return { sid: body.sid };
  }
}

@Injectable()
export class SmsSenderFactory {
  readonly sender: SmsSender;
  constructor(db: Db) {
    this.sender =
      config.smsAdapter === 'twilio' && config.twilioAccountSid
        ? new TwilioSmsSender(config.twilioAccountSid, config.smsAuthToken)
        : new SandboxSmsSender(db);
  }
}
