import * as http from 'node:http';
import * as https from 'node:https';

interface RequestOptions {
  method?: string;
  body?: object | unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

export class IntegrationTestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string
  ) {}

  // -- Health --

  async healthz(): Promise<{ ok: boolean; service: string }> {
    return this.request('GET', '/healthz');
  }

  // -- Catalog --

  async listPacks(): Promise<Array<{ slug: string; name: string; [key: string]: unknown }>> {
    return this.request('GET', '/packs');
  }

  async listScenarios(
    packSlug: string
  ): Promise<Array<{ scenario: string; versions: string[]; templates: string[]; [key: string]: unknown }>> {
    return this.request('GET', `/packs/${packSlug}/scenarios`);
  }

  // -- Launch --

  async getLaunchSchema(
    packSlug: string,
    scenarioSlug: string,
    version: string,
    template?: string
  ): Promise<Record<string, unknown>> {
    const query = template ? { template } : undefined;
    return this.request('GET', `/packs/${packSlug}/scenarios/${scenarioSlug}/versions/${version}/launch-schema`, {
      query
    });
  }

  async compile(body: object): Promise<Record<string, unknown>> {
    return this.request('POST', '/launch/compile', { body });
  }

  // -- Examples --

  async runExample(body: object): Promise<Record<string, unknown>> {
    return this.request('POST', '/examples/run', { body });
  }

  // -- Raw --

  async requestRaw(method: string, path: string, opts?: RequestOptions): Promise<{ status: number; body: unknown }> {
    const url = this.buildUrl(path, opts?.query);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      ...(opts?.headers ?? {})
    };

    const rawBody = opts?.body ? JSON.stringify(opts.body) : undefined;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(url, { method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      if (rawBody) req.write(rawBody);
      req.end();
    });
  }

  // -- Internal --

  private async request<T = any>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    const url = this.buildUrl(path, opts?.query);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
      ...(opts?.headers ?? {})
    };

    const body = opts?.body ? JSON.stringify(opts.body) : undefined;

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(url, { method, headers }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data as unknown as T);
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
}
