import { HttpStatus } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

const SUPPORTED_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);

interface ResolveContext {
  packsRoot: string;
  visited: Set<string>;
  parentFile: string;
}

function fail(message: string, parentFile: string): never {
  throw new AppException(
    ErrorCode.INVALID_PACK_DATA,
    `${message} (in ${parentFile})`,
    HttpStatus.INTERNAL_SERVER_ERROR
  );
}

function resolveIncludePath(includeArg: string, ctx: ResolveContext): string {
  if (typeof includeArg !== 'string' || includeArg.length === 0) {
    fail(`!include requires a non-empty string path`, ctx.parentFile);
  }

  const parentDir = path.dirname(ctx.parentFile);
  const resolved = path.resolve(parentDir, includeArg);

  const packsRootResolved = path.resolve(ctx.packsRoot);
  const boundary = packsRootResolved.endsWith(path.sep) ? packsRootResolved : packsRootResolved + path.sep;
  if (resolved !== packsRootResolved && !resolved.startsWith(boundary)) {
    fail(`!include path escapes PACKS_DIR: ${includeArg}`, ctx.parentFile);
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    fail(`!include unsupported extension "${ext}" for ${includeArg}`, ctx.parentFile);
  }

  if (!fs.existsSync(resolved)) {
    fail(`!include target not found: ${includeArg}`, ctx.parentFile);
  }

  if (ctx.visited.has(resolved)) {
    fail(`!include cycle detected at ${includeArg}`, ctx.parentFile);
  }

  return resolved;
}

function loadFile(filePath: string, packsRoot: string, visited: Set<string>): unknown {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');

  if (ext === '.json') {
    if (content.trim().length === 0) return null;
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new AppException(
        ErrorCode.INVALID_PACK_DATA,
        `invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  return parseYamlContent(content, filePath, packsRoot, visited);
}

/**
 * Builds a one-shot schema carrying the `!include` tag, bound to the file currently being parsed.
 *
 * js-yaml 5 replaced v4's scalar-type constructor and its schema-extension method with
 * `defineScalarTag()` +
 * `Schema.withTags()`. The v4 spelling does not fail silently under v5 — it is two hard `TS2339`s
 * (`Type` gone from the module, `extend` gone from `Schema`), which is why this rewrite is safe to
 * make in the same commit as the bump.
 *
 * `JSON_SCHEMA` is retained DELIBERATELY. Do not "simplify" it to `CORE_SCHEMA` or the default:
 * JSON_SCHEMA is what keeps the YAML-1.1 coercions out, so `yes`/`on`/`off`/`no` stay strings,
 * `2024-01-15` stays a string rather than becoming a Date, `12:30` stays a string rather than a
 * sexagesimal number, and `1_000` stays a string rather than 1000. Pack YAML relies on all of that.
 */
function buildSchema(filePath: string, packsRoot: string, visited: Set<string>): yaml.Schema {
  const includeTag = yaml.defineScalarTag<unknown>('!include', {
    // Load-only tag: `identify` decides whether a value should be DUMPED with this tag, and nothing
    // here ever dumps. Returning false keeps `!include` from being selected on serialisation.
    // v4 had no equivalent; v5 requires it.
    identify: () => false,
    // v4's `construct(data)` becomes v5's `resolve(source, isExplicit, tagName)`. `source` is the
    // scalar's decoded text, so a bare `!include` with no argument arrives as '' where v4 passed
    // null — resolveIncludePath's guard already covers both, and a test pins it.
    resolve: (source: string) => {
      const ctx: ResolveContext = { packsRoot, visited, parentFile: filePath };
      const resolved = resolveIncludePath(source, ctx);
      // Per-branch copy, not a shared mutable set: two siblings including the same fragment must
      // not read as a cycle. Do not "optimise" this away.
      const nextVisited = new Set(visited);
      nextVisited.add(resolved);
      return loadFile(resolved, packsRoot, nextVisited);
    }
  });

  return yaml.JSON_SCHEMA.withTags(includeTag);
}

/**
 * True when the file carries no YAML document at all — every line is blank, a comment, a document
 * marker (`---` / `...`) or a directive (`%YAML 1.2`).
 *
 * This exists because js-yaml 4 and 5 disagree on document-less input in TWO different ways, and
 * only one of them is catchable:
 *
 *   input                 v4 load()    v5 load()
 *   ''  /  '   '          undefined    THROWS 'expected a document, but the input is empty'
 *   '# comment only\n'    null         THROWS (same)
 *   '---\n'               null         '' — does NOT throw
 *
 * The throwing cases are caught below. The `---`-only case is the dangerous one: nothing throws, so
 * a file that used to read as "no content" silently starts reading as an empty STRING. Callers
 * checking `=== null` would take the wrong branch and never know. Normalising here, before parsing,
 * covers all three uniformly and restores v4's contract.
 *
 * Deliberately conservative: it requires EVERY line to be content-free, so a `---` followed by real
 * YAML, a literal block whose body happens to look like comments, or a quoted `'---'` value are all
 * left alone. Tests cover each of those.
 */
function isDocumentless(content: string): boolean {
  return content
    .split('\n')
    .every((line) => /^\s*$/.test(line) || /^\s*#/.test(line) || /^(---|\.\.\.)\s*$/.test(line) || /^%\S/.test(line));
}

function parseYamlContent(content: string, filePath: string, packsRoot: string, visited: Set<string>): unknown {
  if (isDocumentless(content)) return null;
  const schema = buildSchema(filePath, packsRoot, visited);
  try {
    return yaml.load(content, { schema });
  } catch (err) {
    // An AppException thrown inside the tag's resolve() reaches here as ITSELF — js-yaml 5 does not
    // wrap it, so `instanceof` holds, the message survives, and `cause` is undefined. That is what
    // keeps every INVALID_PACK_DATA error code from resolveIncludePath intact. (Returning
    // NOT_RESOLVED instead of throwing would collapse them all into an opaque
    // "cannot resolve a node with !<!nr> explicit tag".)
    if (err instanceof AppException) throw err;
    // Backstop for the throwing half of the v4/v5 document-less disagreement. isDocumentless()
    // above should already have returned null for every input that reaches this, so this branch is
    // belt-and-braces for a shape not anticipated there.
    //
    // NOTE THE COUPLING: it discriminates on js-yaml's own prose because v5's YAMLException carries
    // no error code — `{ name, reason, mark, message }` only, verified against 5.4.2. A future
    // js-yaml release that rewords this message silently disables this branch; the guard above is
    // what keeps that from mattering, which is the other reason to normalise before parsing rather
    // than only here.
    if (err instanceof yaml.YAMLException && /the input is empty/i.test(err.message)) {
      return null;
    }
    throw new AppException(
      ErrorCode.INVALID_PACK_DATA,
      `invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
}

export function loadYamlWithIncludes(filePath: string, packsRoot: string): unknown {
  const absoluteFile = path.resolve(filePath);
  const visited = new Set<string>([absoluteFile]);
  const content = fs.readFileSync(absoluteFile, 'utf-8');
  return parseYamlContent(content, absoluteFile, packsRoot, visited);
}
