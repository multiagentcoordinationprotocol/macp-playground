/**
 * Blast-radius containment for half-written pack files, at the HTTP surface.
 *
 * A placeholder pack file — the thing an author leaves behind when they run
 * `scenario:new` and walk away — must cost exactly the pack it is in. It must
 * never take down the catalog.
 *
 * This is a regression guard for a real defect found during the js-yaml 4 -> 5
 * upgrade. js-yaml 5 parses a document-less file (`---` with only comments
 * after it) to `''`, where js-yaml 4 returned `null`. `FileRegistryLoader`
 * dereferenced the parse result unguarded, so a single `---\n# TODO` file made
 * every catalog route return HTTP 500 — permanently, because the default
 * `REGISTRY_CACHE_TTL_MS` is 0 and the index is rebuilt (and re-thrown) on
 * every request. Two spellings of the same placeholder differed by the entire
 * catalog: `# TODO` cost one pack, `---\n# TODO` cost all of them.
 *
 * The loader-level unit tests in `src/registry/file-registry.loader.spec.ts`
 * cover the shape matrix. This spec exists because the defect's blast radius
 * was an HTTP-surface property, and nothing at that tier proved it fixed:
 * a loader that throws and a loader that skips look identical until something
 * actually serves a request.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/config/app-config.service';
import { GlobalExceptionFilter } from '../../src/errors/exception.filter';
import { buildE2eConfig } from './e2e-config';

const GOOD_PACK = `apiVersion: scenarios.macp.dev/v1
kind: ScenarioPack
metadata:
  slug: healthy
  name: Healthy
  description: A well-formed pack that must survive its neighbours
`;

/**
 * Every spelling of "I started this file and stopped". Each must be contained.
 * `---\\n# TODO` is the one that caused the outage; the others are included so
 * the containment is proven across the whole family rather than the one case
 * that happened to bite.
 */
const PLACEHOLDERS: Array<{ name: string; body: string; why: string }> = [
  { name: 'comment-only', body: '# TODO: write this pack\n', why: 'js-yaml returns undefined' },
  {
    name: 'doc-marker-then-comment',
    body: '---\n# TODO: write this pack\n',
    why: 'js-yaml 5 returns the empty string'
  },
  { name: 'empty', body: '', why: 'zero-byte file' },
  { name: 'whitespace-only', body: '   \n\n\t\n', why: 'whitespace parses to no document' },
  { name: 'doc-marker-only', body: '---\n', why: 'a document marker with nothing under it' },
  { name: 'sequence', body: '- not\n- a\n- mapping\n', why: 'a sequence where a mapping is required' },
  { name: 'scalar', body: 'just-a-string\n', why: 'a bare scalar where a mapping is required' }
];

describe('Registry containment (e2e)', () => {
  let app: INestApplication;
  let packsRoot: string;

  beforeAll(async () => {
    packsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'macp-containment-'));

    // One good pack...
    fs.mkdirSync(path.join(packsRoot, 'healthy'), { recursive: true });
    fs.writeFileSync(path.join(packsRoot, 'healthy', 'pack.yaml'), GOOD_PACK);

    // ...surrounded by every flavour of half-written neighbour.
    for (const placeholder of PLACEHOLDERS) {
      const dir = path.join(packsRoot, `placeholder-${placeholder.name}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pack.yaml'), placeholder.body);
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      // TTL 0 is the production default and the reason the original defect was
      // permanent rather than transient — keep it, so this test exercises the
      // rebuild-per-request path that actually broke.
      .useValue(buildE2eConfig({ packsDir: packsRoot, registryCacheTtlMs: 0 }))
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(packsRoot, { recursive: true, force: true });
  });

  it('serves GET /packs despite every placeholder spelling sharing the directory', async () => {
    const res = await request(app.getHttpServer()).get('/packs').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const slugs = (res.body as Array<{ slug: string }>).map((p) => p.slug);
    expect(slugs).toContain('healthy');
    // The placeholders must be skipped, not surfaced as half-built packs.
    expect(slugs.filter((s) => s.startsWith('placeholder-'))).toEqual([]);
  });

  it('serves GET /scenarios rather than 500ing on the cross-pack walk', async () => {
    const res = await request(app.getHttpServer()).get('/scenarios').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('stays healthy across repeated requests (TTL 0 rebuilds the index every time)', async () => {
    // The original defect was permanent precisely because each request rebuilt
    // and re-threw. One 200 could be a cached fluke; three cannot.
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer()).get('/packs').expect(200);
    }
  });

  it('still 404s an unknown pack rather than 500ing — containment must not swallow real errors', async () => {
    const res = await request(app.getHttpServer()).get('/packs/no-such-pack/scenarios').expect(404);
    expect(res.body.errorCode).toBe('PACK_NOT_FOUND');
  });
});
