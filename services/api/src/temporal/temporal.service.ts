import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Client, Connection, WorkflowHandle } from '@temporalio/client';
import { config } from '../config';

export interface LeadWorkflowInput {
  tenant_id: string;
  contact_id: string;
  conversation_id: string;
}

export const LEAD_WORKFLOW = 'LeadNurtureWorkflow';
export const workflowIdFor = (conversationId: string) => `lead-${conversationId}`;

/**
 * Thin Temporal client. The API never runs workflow logic; it starts or signals the
 * per-lead workflow (signal-with-start, so the first signal and the start are atomic)
 * and queries its state for the console.
 */
@Injectable()
export class TemporalService implements OnApplicationShutdown {
  private readonly log = new Logger('temporal');
  private client?: Client;
  private connection?: Connection;

  private async getClient(): Promise<Client> {
    if (!this.client) {
      this.connection = await Connection.connect({ address: config.temporalAddress });
      this.client = new Client({ connection: this.connection, namespace: config.temporalNamespace });
    }
    return this.client;
  }

  async signalWithStart(input: LeadWorkflowInput, signal: string, args: unknown[]): Promise<string> {
    const client = await this.getClient();
    const workflowId = workflowIdFor(input.conversation_id);
    await client.workflow.signalWithStart(LEAD_WORKFLOW, {
      workflowId,
      taskQueue: config.temporalTaskQueue,
      args: [input],
      signal,
      signalArgs: args,
    });
    return workflowId;
  }

  async signal(workflowId: string, signal: string, args: unknown[] = []): Promise<boolean> {
    try {
      const handle: WorkflowHandle = (await this.getClient()).workflow.getHandle(workflowId);
      await handle.signal(signal, ...args);
      return true;
    } catch (err) {
      this.log.warn(`signal ${signal} to ${workflowId} failed: ${(err as Error).message}`);
      return false;
    }
  }

  async describe(workflowId: string): Promise<{ status: string; state: Record<string, unknown> | null } | null> {
    try {
      const handle = (await this.getClient()).workflow.getHandle(workflowId);
      const desc = await handle.describe();
      let state: Record<string, unknown> | null = null;
      if (desc.status.name === 'RUNNING') {
        state = await handle.query<Record<string, unknown>>('state').catch(() => null);
      }
      return { status: desc.status.name, state };
    } catch {
      return null;
    }
  }

  async onApplicationShutdown() {
    await this.connection?.close().catch(() => undefined);
  }
}
