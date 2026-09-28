import { Injectable, Logger } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import {
  PackEntry,
  PackFile,
  RegistrySnapshot,
  ScenarioEntry,
  ScenarioTemplateFile,
  ScenarioVersionEntry,
  ScenarioVersionFile
} from '../contracts/registry';
import { loadYamlWithIncludes } from './include-resolver';

/**
 * A parsed document that is not a mapping at all — `null` (a comment-only placeholder), `''` (a
 * marker-only `---`), a sequence, or a bare scalar — is not a *malformed* pack; it is *not a pack
 * document*. The loader contains the two classes differently, on purpose:
 *
 *   - not a pack document at all              -> log, skip this pack (or this version), keep
 *                                                serving everything else
 *   - claims to be a pack but is wrong        -> AppException(INVALID_PACK_DATA), which `loadAll`
 *     (apiVersion / kind / metadata.slug)        deliberately rethrows, failing the whole load
 *
 * Restoring that split is a REQUIREMENT of the js-yaml 4 -> 5 upgrade, not a new policy. Under v4
 * every document-less spelling parsed to `null`, so the unguarded `data.apiVersion` below raised a
 * TypeError — not an AppException, and therefore caught by `loadAll`'s per-pack catch. Under v5
 * `'---\n'` parses to `''` instead, and `''.apiVersion` is `undefined` rather than a throw, so it
 * reached the apiVersion check and raised INVALID_PACK_DATA, which `loadAll` rethrows.
 *
 * The consequence was that two spellings of the same placeholder differed by the entire catalog:
 * `'# TODO\n'` cost one pack, while `'---\n# TODO\n'` returned HTTP 500 INVALID_PACK_DATA from
 * `/packs`, `/scenarios`, `/launch/compile` and every other catalog route — permanently, because
 * the default `REGISTRY_CACHE_TTL_MS=0` reloads on every request and so never caches past it.
 *
 * Guarding the shape explicitly puts both spellings on the contained path deliberately, with a
 * message that names the real problem, instead of leaving the blast radius to depend on which
 * falsy value js-yaml happened to choose.
 */
function isMappingDocument(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

function describeDocumentShape(data: unknown): string {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'a sequence';
  if (data === '') return 'an empty document';
  return `a ${typeof data}`;
}

@Injectable()
export class FileRegistryLoader {
  private readonly logger = new Logger(FileRegistryLoader.name);
  private readonly packsDir: string;

  constructor(config: AppConfigService) {
    this.packsDir = path.resolve(config.packsDir);
  }

  async loadAll(): Promise<RegistrySnapshot> {
    const packs = new Map<string, PackEntry>();

    let entries: string[];
    try {
      entries = await fs.readdir(this.packsDir);
    } catch {
      this.logger.warn(`packs directory not found: ${this.packsDir}`);
      return { packs, loadedAt: Date.now() };
    }

    for (const entry of entries) {
      if (entry.startsWith('_')) continue;
      const packDir = path.join(this.packsDir, entry);
      const stat = await fs.stat(packDir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const packYamlPath = path.join(packDir, 'pack.yaml');
      const packYamlExists = await fs
        .access(packYamlPath)
        .then(() => true)
        .catch(() => false);

      if (!packYamlExists) {
        this.logger.warn(`skipping directory without pack.yaml: ${entry}`);
        continue;
      }

      try {
        const pack = await this.loadPackFile(packYamlPath);
        // null = "pack.yaml is not a pack document"; already logged, and deliberately contained to
        // this one pack rather than failing the whole load. See isMappingDocument() above.
        if (pack === null) continue;
        const scenarios = await this.discoverScenarios(packDir);
        packs.set(pack.metadata.slug, { pack, scenarios });
      } catch (err) {
        if (err instanceof AppException) throw err;
        this.logger.error(`failed to load pack ${entry}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.logger.log(`loaded ${packs.size} pack(s)`);
    return { packs, loadedAt: Date.now() };
  }

  private async loadPackFile(filePath: string): Promise<PackFile | null> {
    const parsed = this.parseYamlFile(filePath);
    if (!isMappingDocument(parsed)) {
      this.logger.error(`skipping pack: ${filePath} must contain a YAML mapping, got ${describeDocumentShape(parsed)}`);
      return null;
    }
    const data = parsed as unknown as PackFile;

    if (data.apiVersion !== 'scenarios.macp.dev/v1') {
      throw new AppException(
        ErrorCode.INVALID_PACK_DATA,
        `invalid apiVersion in ${filePath}: ${data.apiVersion}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
    if (data.kind !== 'ScenarioPack') {
      throw new AppException(
        ErrorCode.INVALID_PACK_DATA,
        `invalid kind in ${filePath}: expected ScenarioPack, got ${data.kind}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
    if (!data.metadata?.slug) {
      throw new AppException(
        ErrorCode.INVALID_PACK_DATA,
        `missing metadata.slug in ${filePath}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    return data;
  }

  private async discoverScenarios(packDir: string): Promise<Map<string, ScenarioEntry>> {
    const scenariosDir = path.join(packDir, 'scenarios');
    const scenarios = new Map<string, ScenarioEntry>();

    const scenarioDirs = await fs.readdir(scenariosDir).catch(() => [] as string[]);

    for (const scenarioSlug of scenarioDirs) {
      const scenarioDir = path.join(scenariosDir, scenarioSlug);
      const stat = await fs.stat(scenarioDir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const versions = await this.discoverVersions(scenarioDir);
      if (versions.size > 0) {
        scenarios.set(scenarioSlug, { versions });
      }
    }

    return scenarios;
  }

  private async discoverVersions(scenarioDir: string): Promise<Map<string, ScenarioVersionEntry>> {
    const versions = new Map<string, ScenarioVersionEntry>();
    const versionDirs = await fs.readdir(scenarioDir).catch(() => [] as string[]);

    for (const version of versionDirs) {
      const versionDir = path.join(scenarioDir, version);
      const stat = await fs.stat(versionDir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const scenarioYamlPath = path.join(versionDir, 'scenario.yaml');
      const scenarioYamlExists = await fs
        .access(scenarioYamlPath)
        .then(() => true)
        .catch(() => false);

      if (!scenarioYamlExists) continue;

      const scenario = await this.loadScenarioFile(scenarioYamlPath);
      // null = "scenario.yaml is not a scenario document"; already logged. Contained to this one
      // version: the pack and its other versions still load. (Under js-yaml 4 the equivalent input
      // raised a TypeError that unwound to loadAll's catch and cost the whole pack — narrowing that
      // to the offending version is a deliberate improvement, not an accident of the upgrade.)
      if (scenario === null) continue;
      const templates = await this.discoverTemplates(versionDir);
      versions.set(version, { scenario, templates });
    }

    return versions;
  }

  private async loadScenarioFile(filePath: string): Promise<ScenarioVersionFile | null> {
    const parsed = this.parseYamlFile(filePath);
    if (!isMappingDocument(parsed)) {
      this.logger.error(
        `skipping version: ${filePath} must contain a YAML mapping, got ${describeDocumentShape(parsed)}`
      );
      return null;
    }
    const data = parsed as unknown as ScenarioVersionFile;

    if (data.apiVersion !== 'scenarios.macp.dev/v1') {
      throw new AppException(
        ErrorCode.INVALID_PACK_DATA,
        `invalid apiVersion in ${filePath}: ${data.apiVersion}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
    if (data.kind !== 'ScenarioVersion') {
      throw new AppException(
        ErrorCode.INVALID_PACK_DATA,
        `invalid kind in ${filePath}: expected ScenarioVersion, got ${data.kind}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    return data;
  }

  private async discoverTemplates(versionDir: string): Promise<Map<string, ScenarioTemplateFile>> {
    const templatesDir = path.join(versionDir, 'templates');
    const templates = new Map<string, ScenarioTemplateFile>();

    const files = await fs.readdir(templatesDir).catch(() => [] as string[]);

    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

      const filePath = path.join(templatesDir, file);
      const data = this.parseYamlFile(filePath) as ScenarioTemplateFile;

      if (data?.kind === 'ScenarioTemplate' && data.metadata?.slug) {
        templates.set(data.metadata.slug, data);
      }
    }

    return templates;
  }

  private parseYamlFile(filePath: string): unknown {
    try {
      return loadYamlWithIncludes(filePath, this.packsDir);
    } catch (err) {
      if (err instanceof AppException) throw err;
      throw new AppException(
        ErrorCode.INVALID_PACK_DATA,
        `invalid YAML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
