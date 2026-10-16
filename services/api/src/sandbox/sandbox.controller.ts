import { randomBytes } from 'crypto';
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { config } from '../config';
import { isFictional, toE164 } from '../common/phone';
import { parseBody } from '../common/validate';
import { Db } from '../db/db.service';
import { INBOUND_PATH } from '../messaging/webhook.controller';
import { twilioSignature } from '../messaging/twilio-signature';

/**
 * A sandbox handset for development and demos. Outbound texts land in sandbox_sms;
 * replies typed here are posted to the real inbound webhook, signed exactly the way the
 * SMS provider signs them, so the whole inbound path runs unchanged.
 */
@Controller('sandbox')
export class SandboxController {
  constructor(private readonly db: Db) {}

  private guard() {
    if (config.smsAdapter !== 'sandbox') throw new NotFoundException();
  }

  @Get('handsets')
  async handsets() {
    this.guard();
    return this.db.platformQuery(`
      SELECT DISTINCT ON (s.handset) s.handset, s.brokerage_number, s.body AS last_body, s.direction AS last_direction,
             s.created_at AS last_at, t.name AS office, t.slug AS office_slug
      FROM sandbox_sms s LEFT JOIN tenants t ON t.sms_number = s.brokerage_number
      ORDER BY s.handset, s.id DESC`);
  }

  @Get('handsets/:handset/messages')
  async thread(@Param('handset') handset: string, @Query('after') after?: string) {
    this.guard();
    const phone = toE164(handset);
    if (!phone) throw new BadRequestException('bad number');
    return this.db.platformQuery(
      `SELECT s.id, s.direction, s.body, s.brokerage_number, s.created_at, t.name AS office
       FROM sandbox_sms s LEFT JOIN tenants t ON t.sms_number = s.brokerage_number
       WHERE s.handset = $1 AND s.id > $2 ORDER BY s.id`,
      [phone, Number(after ?? 0)],
    );
  }

  @Post('handsets/:handset/send')
  @HttpCode(200)
  async send(@Param('handset') handset: string, @Body() body: unknown) {
    this.guard();
    const b = parseBody(z.object({ to: z.string(), body: z.string().min(1).max(320) }), body);
    const from = toE164(handset);
    const to = toE164(b.to);
    if (!from || !isFictional(from) || !to) throw new BadRequestException('sandbox handsets must use fictional 555-01xx numbers');
    const sid = `SM${randomBytes(16).toString('hex')}`;
    await this.db.platformQuery(
      `INSERT INTO sandbox_sms (tenant_id, direction, handset, brokerage_number, body, provider_sid)
       VALUES ((SELECT id FROM tenants WHERE sms_number = $2), 'from_handset', $1, $2, $3, $4)`,
      [from, to, b.body, sid],
    );
    const params = { AccountSid: 'ACsandbox', From: from, To: to, Body: b.body, MessageSid: sid, NumMedia: '0' };
    const signature = twilioSignature(config.smsAuthToken, `${config.publicWebhookBase}${INBOUND_PATH}`, params);
    const res = await fetch(`http://127.0.0.1:${config.port}${INBOUND_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      body: new URLSearchParams(params),
    });
    return { sid, webhook_status: res.status };
  }
}
