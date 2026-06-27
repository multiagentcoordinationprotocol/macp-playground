import * as http from 'node:http';

export interface MintRecord {
  sender: string;
  scopes?: Record<string, unknown>;
  ttl_seconds?: number;
  authorization?: string;
  timestamp: Date;
}

export interface MockAuthServiceOptions {
  /** When true, every call returns HTTP 500 (simulates auth-service outage). */
  failAll?: boolean;
  /** Delay before responding in ms (simulates timeout). */
  delayMs?: number;
  /** Override the token returned by the mock. Defaults to `jwt.<sender>.<seq>`. */
  tokenBuilder?: (record: MintRecord, seq: number) => string;
  /** `expires_in_seconds` returned to the client. Defaults to echoing request TTL or 3600. */
  expiresInSeconds?: number;
}

/**
 * Minimal mock of the standalone auth-service `POST /tokens` endpoint used by
 * AUTH-2 integration tests. Records every request for assertion, supports
 * configurable failure / delay modes, and never requires real cryptography —
 * the mock returns an opaque string the macp-playground service treats as a Bearer.
 */
export class MockAuthService {
  private server!: http.Server;
  private _port = 0;
  private _records: MintRecord[] = [];
  private _options: MockAuthServiceOptions;
  private _seq = 0;

  constructor(options: MockAuthServiceOptions = {}) {
    this._options = options;
  }

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get records(): readonly MintRecord[] {
    return this._records;
  }

  setOptions(options: Partial<MockAuthServiceOptions>): void {
    this._options = { ...this._options, ...options };
  }

  clear(): void {
    this._records = [];
    this._seq = 0;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as { port: number };
        this._port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void this.dispatch(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse, rawBody: string): Promise<void> {
    if (req.url !== '/tokens' || req.method !== 'POST') {
      res.statusCode = 404;
      res.end();
      return;
    }

    let body: { sender?: string; scopes?: Record<string, unknown>; ttl_seconds?: number } = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      res.statusCode = 400;
      res.end('invalid JSON');
      return;
    }

    const record: MintRecord = {
      sender: body.sender ?? '',
      scopes: body.scopes,
      ttl_seconds: body.ttl_seconds,
      authorization: req.headers['authorization'] as string | undefined,
      timestamp: new Date()
    };
    this._records.push(record);

    if (this._options.delayMs) {
      await new Promise((r) => setTimeout(r, this._options.delayMs));
    }

    if (this._options.failAll) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'mock forced failure' }));
      return;
    }

    if (!record.sender) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'sender is required' }));
      return;
    }

    this._seq += 1;
    const token = this._options.tokenBuilder
      ? this._options.tokenBuilder(record, this._seq)
      : `jwt.${record.sender}.${this._seq}`;
    const expiresIn = this._options.expiresInSeconds ?? record.ttl_seconds ?? 3600;

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        token,
        sender: record.sender,
        expires_in_seconds: expiresIn
      })
    );
  }
}
