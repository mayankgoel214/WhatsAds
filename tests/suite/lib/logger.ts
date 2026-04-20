import { appendFile } from 'node:fs/promises';

export class RunLogger {
  constructor(private logPath: string) {}

  async info(event: string, data?: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', event, ...data }) + '\n';
    await appendFile(this.logPath, line);
    console.log(`[${event}]`, data ? JSON.stringify(data) : '');
  }

  async warn(event: string, data?: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', event, ...data }) + '\n';
    await appendFile(this.logPath, line);
    console.warn(`[WARN ${event}]`, data ? JSON.stringify(data) : '');
  }

  async error(event: string, data?: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', event, ...data }) + '\n';
    await appendFile(this.logPath, line);
    console.error(`[ERROR ${event}]`, data ? JSON.stringify(data) : '');
  }
}
