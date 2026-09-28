import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { loadYamlWithIncludes } from './include-resolver';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

describe('loadYamlWithIncludes', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'include-resolver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): string {
    const abs = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    return abs;
  }

  it('parses a plain YAML file with no includes', () => {
    const file = writeFile('a.yaml', 'foo: 1\nbar: hello\n');
    const result = loadYamlWithIncludes(file, tmpRoot) as Record<string, unknown>;
    expect(result).toEqual({ foo: 1, bar: 'hello' });
  });

  it('returns null for an empty file', () => {
    const file = writeFile('a.yaml', '');
    expect(loadYamlWithIncludes(file, tmpRoot)).toBeNull();
  });

  it('inlines a sibling YAML file', () => {
    writeFile('participants.yaml', '- id: agent-1\n  role: x\n');
    const main = writeFile('scenario.yaml', 'name: test\nparticipants: !include ./participants.yaml\n');
    const result = loadYamlWithIncludes(main, tmpRoot) as Record<string, unknown>;
    expect(result).toEqual({ name: 'test', participants: [{ id: 'agent-1', role: 'x' }] });
  });

  it('inlines a sibling JSON file', () => {
    writeFile('data/customers.json', '[{"id":"c1"},{"id":"c2"}]');
    const main = writeFile('scenario.yaml', 'customers: !include ./data/customers.json\n');
    const result = loadYamlWithIncludes(main, tmpRoot) as Record<string, unknown>;
    expect(result.customers).toEqual([{ id: 'c1' }, { id: 'c2' }]);
  });

  it('resolves relative paths from the file containing the include', () => {
    writeFile('packs/_shared/p.yaml', 'shared: true\n');
    writeFile(
      'packs/fraud/scenarios/s/1.0.0/templates/default.yaml',
      'overrides: !include ../../../../../_shared/p.yaml\n'
    );
    const tmplPath = path.join(tmpRoot, 'packs/fraud/scenarios/s/1.0.0/templates/default.yaml');
    const result = loadYamlWithIncludes(tmplPath, tmpRoot) as Record<string, unknown>;
    expect(result.overrides).toEqual({ shared: true });
  });

  it('supports recursive includes', () => {
    writeFile('c.yaml', 'leaf: c\n');
    writeFile('b.yaml', 'mid: !include ./c.yaml\n');
    const main = writeFile('a.yaml', 'root: !include ./b.yaml\n');
    const result = loadYamlWithIncludes(main, tmpRoot) as Record<string, unknown>;
    expect(result).toEqual({ root: { mid: { leaf: 'c' } } });
  });

  it('rejects path escape attempts', () => {
    const main = writeFile('a.yaml', 'data: !include ../../../etc/passwd\n');
    try {
      loadYamlWithIncludes(main, tmpRoot);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_PACK_DATA);
      expect((err as AppException).message).toContain('escapes PACKS_DIR');
    }
  });

  it('rejects absolute paths outside packs root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'leak.yaml'), 'x: 1');
    const main = writeFile('a.yaml', `data: !include ${path.join(outside, 'leak.yaml')}\n`);
    try {
      loadYamlWithIncludes(main, tmpRoot);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_PACK_DATA);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('detects cycles', () => {
    writeFile('b.yaml', 'back: !include ./a.yaml\n');
    const main = writeFile('a.yaml', 'next: !include ./b.yaml\n');
    try {
      loadYamlWithIncludes(main, tmpRoot);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_PACK_DATA);
      expect((err as AppException).message).toContain('cycle');
    }
  });

  it('throws when the target is missing', () => {
    const main = writeFile('a.yaml', 'data: !include ./nope.yaml\n');
    try {
      loadYamlWithIncludes(main, tmpRoot);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).message).toContain('not found');
    }
  });

  it('rejects unsupported extensions', () => {
    writeFile('data.txt', 'hello');
    const main = writeFile('a.yaml', 'data: !include ./data.txt\n');
    try {
      loadYamlWithIncludes(main, tmpRoot);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).message).toContain('unsupported extension');
    }
  });

  it('throws on invalid JSON included files', () => {
    writeFile('bad.json', '{not valid');
    const main = writeFile('a.yaml', 'data: !include ./bad.json\n');
    try {
      loadYamlWithIncludes(main, tmpRoot);
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).message).toContain('invalid JSON');
    }
  });

  it('allows two siblings to include the same fragment without flagging a cycle', () => {
    writeFile('shared.yaml', 'value: 42\n');
    const main = writeFile('a.yaml', 'first: !include ./shared.yaml\nsecond: !include ./shared.yaml\n');
    const result = loadYamlWithIncludes(main, tmpRoot) as Record<string, unknown>;
    expect(result).toEqual({ first: { value: 42 }, second: { value: 42 } });
  });

  // Each case below pins down one place where js-yaml 5 differs from 4, so that a future reader
  // meeting the behaviour does not mistake it for a pack bug and "fix" it.
  describe('js-yaml 5 semantics', () => {
    it('raises INVALID_PACK_DATA for a bare !include with no path', () => {
      // v5 hands resolve() the decoded scalar text, so a bare tag arrives as '' where v4 passed
      // null. resolveIncludePath's guard covers both; this asserts it, because include-resolver.ts's
      // only uncovered lines were exactly this guard and the empty-document branch.
      const main = writeFile('a.yaml', 'participants: !include\n');
      let caught: unknown;
      try {
        loadYamlWithIncludes(main, tmpRoot);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).errorCode).toBe(ErrorCode.INVALID_PACK_DATA);
      expect((caught as AppException).message).toContain('non-empty string path');
    });

    it('returns null for a comment-only file rather than raising', () => {
      // The one genuine v4 -> v5 behaviour change that needed handling. v4's load() returned null
      // here; v5 throws `YAMLException: expected a document, but the input is empty`. Without the
      // guard this surfaced as `INVALID_PACK_DATA: invalid YAML in ...`, which would be baffling for
      // a pack author who left a placeholder of comments.
      const file = writeFile('a.yaml', '# nothing here yet\n# still nothing\n');
      expect(loadYamlWithIncludes(file, tmpRoot)).toBeNull();
    });

    it('returns null for a whitespace-only file', () => {
      // Covered by the pre-parse guard rather than the YAMLException branch, but both inputs throw
      // under v5, so assert both paths rather than assuming one implies the other.
      const file = writeFile('a.yaml', '   \n\t\n');
      expect(loadYamlWithIncludes(file, tmpRoot)).toBeNull();
    });

    it('keeps JSON_SCHEMA coercions off: yes/on/dates/times/underscored numbers stay strings', () => {
      // This is why buildSchema() must keep JSON_SCHEMA and not fall back to CORE_SCHEMA or the
      // default. Under YAML 1.1 coercions every one of these would change type, and pack YAML
      // (mode names, versions, configuration ids) depends on them staying text.
      const file = writeFile(
        'a.yaml',
        [
          'boolish: yes',
          'onish: on',
          'offish: off',
          'noish: no',
          'dateish: 2024-01-15',
          'timeish: 12:30',
          'underscored: 1_000'
        ].join('\n') + '\n'
      );
      const result = loadYamlWithIncludes(file, tmpRoot) as Record<string, unknown>;
      expect(result).toEqual({
        boolish: 'yes',
        onish: 'on',
        offish: 'off',
        noish: 'no',
        dateish: '2024-01-15',
        timeish: '12:30',
        underscored: '1_000'
      });
      // Belt and braces: a Date here would mean the schema silently changed.
      expect(result.dateish).not.toBeInstanceOf(Date);
    });

    it('still parses real JSON scalars as JSON', () => {
      // The complement of the case above: JSON_SCHEMA is not "everything is a string".
      const file = writeFile('a.yaml', 'yes: true\nnope: false\nint: 42\nfloat: 3.5\nnil: null\n');
      expect(loadYamlWithIncludes(file, tmpRoot)).toEqual({
        yes: true,
        nope: false,
        int: 42,
        float: 3.5,
        nil: null
      });
    });

    it('no longer treats ~, Null, NULL or an empty value as null — only lowercase null', () => {
      // THE BIGGEST BEHAVIOUR CHANGE IN THIS UPGRADE, and wider than the upgrade plan recorded.
      // The plan named only `~`; measured against both versions, FOUR spellings changed:
      //
      //   YAML        js-yaml 4 JSON_SCHEMA   js-yaml 5 JSON_SCHEMA
      //   ~           null                    '~'      (string)
      //   Null        null                    'Null'   (string)
      //   NULL        null                    'NULL'   (string)
      //   key:        null                    ''       (empty string)
      //   null        null                    null     (unchanged)
      //
      // v5's JSON_SCHEMA follows JSON strictly, and JSON spells null exactly one way. This is a
      // SILENT change: nothing throws, a field simply arrives as a short string instead of null, so
      // any `if (!value)` check still treats '' as absent while '~' / 'Null' / 'NULL' now look
      // PRESENT. A pack author writing `description: ~` to mean "none" now ships a commitment whose
      // description is a literal tilde, and the lint check passes it.
      //
      // Verified safe for this repo at the time of the upgrade: no `~`/`Null`/`NULL` value occurs in
      // any file under packs/ or test/fixtures/packs/ (grepped), every bare `key:` there is a parent
      // of an indented block rather than an empty value, and packs-on-disk.spec.ts confirms all 13
      // shipped files parse byte-identically to the fixture generated under v4.
      const file = writeFile(
        'a.yaml',
        ['tilde: ~', 'titlecase: Null', 'upper: NULL', 'lower: null', 'empty:'].join('\n') + '\n'
      );
      expect(loadYamlWithIncludes(file, tmpRoot)).toEqual({
        tilde: '~',
        titlecase: 'Null',
        upper: 'NULL',
        lower: null,
        empty: ''
      });
    });

    it('wraps a genuinely malformed document as INVALID_PACK_DATA', () => {
      // The complement of the empty-document branch: a real syntax error must still become an
      // AppException with the file named, not leak a raw YAMLException to the caller. Without this
      // the only untested path through the catch block was the one that actually reports breakage.
      const file = writeFile('a.yaml', 'foo: [1, 2\nbar: }{\n');
      let caught: unknown;
      try {
        loadYamlWithIncludes(file, tmpRoot);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).errorCode).toBe(ErrorCode.INVALID_PACK_DATA);
      expect((caught as AppException).message).toContain('invalid YAML in');
      expect((caught as AppException).message).toContain('a.yaml');
    });

    it('is a load-only tag: dumping an included value never re-emits !include', () => {
      // Asserts the observable PROPERTY the tag's `identify: () => false` exists to guarantee: a
      // loaded pack round-trips through dump/load without `!include` reappearing against an inlined
      // object, which the next load would then try to treat as a path.
      //
      // Note what this does NOT do: it cannot execute `identify` itself. `buildSchema` is private
      // and nothing in the module dumps, so the tag-bearing schema never reaches a dump call — which
      // is exactly why `identify` shows as the module's one uncovered line. Exporting buildSchema
      // purely to reach it would weaken the boundary for a coverage number, so the line stays
      // uncovered and this test pins the behaviour a reader actually depends on.
      writeFile('shared.yaml', 'value: 42\n');
      const main = writeFile('a.yaml', 'nested: !include ./shared.yaml\n');
      const loaded = loadYamlWithIncludes(main, tmpRoot);

      const dumped = yaml.dump(loaded, { schema: yaml.JSON_SCHEMA });
      expect(dumped).not.toContain('!include');
      expect(yaml.load(dumped, { schema: yaml.JSON_SCHEMA })).toEqual({ nested: { value: 42 } });
    });

    it('propagates an AppException out of a nested include unwrapped, not as a YAMLException', () => {
      // Load-bearing: v5 does not wrap an error thrown inside a tag's resolve(), which is what keeps
      // every INVALID_PACK_DATA code and message from resolveIncludePath intact through two levels
      // of nesting. If v5 ever wrapped it, this fails instead of degrading into an opaque message.
      writeFile('inner.yaml', 'bad: !include ./does-not-exist.yaml\n');
      const main = writeFile('outer.yaml', 'nested: !include ./inner.yaml\n');
      let caught: unknown;
      try {
        loadYamlWithIncludes(main, tmpRoot);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppException);
      expect((caught as AppException).errorCode).toBe(ErrorCode.INVALID_PACK_DATA);
      expect((caught as AppException).message).toContain('not found');
      expect((caught as Error).message).not.toContain('explicit tag');
    });
  });
});
