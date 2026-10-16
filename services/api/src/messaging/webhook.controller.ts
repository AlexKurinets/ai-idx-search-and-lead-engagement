import { Body, Controller, ForbiddenException, Headers, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { config } from '../config';
import { MessagingService } from './messaging.service';
import { verifyTwilioSignature } from './twilio-signature';

export const INBOUND_PATH = '/webhooks/sms/inbound';

@Controller('webhooks/sms')
export class WebhookController {
  constructor(private readonly messaging: MessagingService) {}

  /**
   * Twilio-shaped inbound SMS webhook. The signature is checked against the public URL
   * the provider called, before anything is parsed or stored.
   */
  @Post('inbound')
  @HttpCode(200)
  async inbound(
    @Body() body: Record<string, string>,
    @Headers('x-twilio-signature') signature: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const url = `${config.publicWebhookBase}${INBOUND_PATH}`;
    if (!verifyTwilioSignature(config.smsAuthToken, url, body ?? {}, signature)) {
      throw new ForbiddenException('invalid signature');
    }
    await this.messaging.inbound({ From: body.From, To: body.To, Body: body.Body ?? '', MessageSid: body.MessageSid });
    res.type('text/xml');
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }
}
