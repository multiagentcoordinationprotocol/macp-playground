import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

    it('accepts ONLY JSON spellings for null, booleans and numbers — everything else is a string', () => {
      // The rule, which is the only reliable way to hold this: js-yaml 5's JSON_SCHEMA *is* JSON —
      // one spelling for null, one each for true and false, one number grammar. Anything outside
      // that grammar is a plain string. Measured against 4.3.0 (the version actually locked before
      // the bump, per package-lock.json at the fixture commit), 25 of 26 probe values changed.
      //
      // Deliberately NOT presented as a complete list: the non-JSON number forms are open-ended, and
      // two earlier attempts to enumerate them were both wrong. See DECISIONS.md.
      //
      // THE DANGEROUS ROW IS `False`. A null degrading to '~' at least looks odd on inspection, but
      // 'False' is a non-empty string and therefore TRUTHY — a governance flag written `False`
      // silently reads as ENABLED. Nothing throws in any of these cases; a field simply arrives as
      // text, and while '' still reads as absent to a truthiness check, '~'/'Null'/'False' read as
      // PRESENT. A pack author writing `description: ~` to mean "none" ships a commitment whose
      // description is a literal tilde, and scenario:lint passes it.
      //
      // Verified safe for this repo at the time of the upgrade: no affected spelling occurs as a
      // value or sequence item anywhere under packs/, test/fixtures/packs/, policies/ or schemas/,
      // and packs-on-disk.spec.ts confirms all 13 shipped files parse byte-identically to the
      // fixture generated under 4.3.0.
      const file = writeFile(
        'a.yaml',
        [
          'tilde: ~',
          'titlecase: Null',
          'upperNull: NULL',
          'lowerNull: null',
          'emptyValue:',
          'lowerTrue: true',
          'titleTrue: True',
          'upperTrue: TRUE',
          'lowerFalse: false',
          'titleFalse: False',
          'upperFalse: FALSE',
          'plusFive: +5',
          'minusFive: -5',
          'leadingDot: .5',
          'zeroDot: 0.5',
          'octalish: 007',
          'binary: 0b101',
          'octal: 0o17',
          'hex: 0x1F',
          'inf: .inf',
          'nan: .nan',
          'underscored: 1_000',
          'plainInt: 42'
        ].join('\n') + '\n'
      );
      expect(loadYamlWithIncludes(file, tmpRoot)).toEqual({
        // Nulls: only the JSON spelling survives.
        tilde: '~',
        titlecase: 'Null',
        upperNull: 'NULL',
        lowerNull: null,
        emptyValue: '',
        // Booleans: only the JSON spellings survive. The capitalised forms become TRUTHY strings.
        lowerTrue: true,
        titleTrue: 'True',
        upperTrue: 'TRUE',
        lowerFalse: false,
        titleFalse: 'False',
        upperFalse: 'FALSE',
        // Numbers: only the JSON grammar survives.
        plusFive: '+5',
        minusFive: -5,
        leadingDot: '.5',
        zeroDot: 0.5,
        octalish: '007',
        binary: '0b101',
        octal: '0o17',
        hex: '0x1F',
        inf: '.inf',
        nan: '.nan',
        underscored: '1_000',
        plainInt: 42
      });
    });

    it('makes the capitalised booleans truthy, which is the sharpest edge of the JSON-only rule', () => {
      // Separated out and asserted on truthiness directly, because the table above is easy to read
      // as a cosmetic type change. It is not: this is the shape of a silently inverted control.
      const file = writeFile('a.yaml', 'vetoEnabled: False\n');
      const parsed = loadYamlWithIncludes(file, tmpRoot) as Record<string, unknown>;
      expect(parsed.vetoEnabled).toBe('False');
      expect(Boolean(parsed.vetoEnabled)).toBe(true);
      // Which is the exact opposite of what the author wrote, and of what js-yaml 4 produced.
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

    it("yields '' (not null) for a marker-only file, and that is deliberately NOT normalised", () => {
      // js-yaml 4 returned null here; v5 returns '' and does not throw. Left alone on purpose. Both
      // are falsy and every consumer treats them the same — and at `scripts/scenario/lint.ts` the
      // empty string is the SAFER of the two, because that code dereferences the parsed document
      // directly: `null.metadata` throws, `''.metadata` is undefined. An earlier attempt to
      // normalise this with a line-scanning helper regressed behaviour, returning null for input
      // js-yaml REJECTS and so converting a reportable finding into a downstream crash. See the
      // block comment in include-resolver.ts. Asserting the real value is what stops that being
      // reintroduced as a "fix".
      expect(loadYamlWithIncludes(writeFile('a.yaml', '---\n'), tmpRoot)).toBe('');
      expect(loadYamlWithIncludes(writeFile('b.yaml', '--- # placeholder\n'), tmpRoot)).toBe('');
      expect(loadYamlWithIncludes(writeFile('c.yaml', '  ---\n'), tmpRoot)).toBe('');
    });

    it('still REPORTS input that js-yaml rejects, rather than silently treating it as empty', () => {
      // Regression guard for the above. Each of these is invalid to both js-yaml 4 and 5 and must
      // surface as INVALID_PACK_DATA, so a caller's try/catch can report it — never as a quiet null
      // the caller then dereferences.
      const cases: Array<[string, string]> = [
        ['directive-without-marker.yaml', '%YAML 1.2\n'],
        ['two-documents.yaml', '---\n---\n'],
        ['two-documents-commented.yaml', '---\n# a\n---\n# b\n']
      ];
      for (const [name, content] of cases) {
        let caught: unknown;
        try {
          loadYamlWithIncludes(writeFile(name, content), tmpRoot);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(AppException);
        expect((caught as AppException).errorCode).toBe(ErrorCode.INVALID_PACK_DATA);
        expect((caught as AppException).message).toContain('invalid YAML in');
      }
    });

    it('does not confuse content that merely looks like a marker or a comment', () => {
      expect(loadYamlWithIncludes(writeFile('a.yaml', '---\nkey: value\n'), tmpRoot)).toEqual({ key: 'value' });
      expect(loadYamlWithIncludes(writeFile('b.yaml', 'key: |\n  # not a comment, a string\n'), tmpRoot)).toEqual({
        key: '# not a comment, a string\n'
      });
      expect(loadYamlWithIncludes(writeFile('c.yaml', "key: '---'\n"), tmpRoot)).toEqual({ key: '---' });
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
