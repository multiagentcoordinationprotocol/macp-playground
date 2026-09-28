import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import { CompilerService } from '../../src/compiler/compiler.service';
import { RegistryIndexService } from '../../src/registry/registry-index.service';
import { FileRegistryLoader } from '../../src/registry/file-registry.loader';
import { AppConfigService } from '../../src/config/app-config.service';
import { AppException } from '../../src/errors/app-exception';

// Silence Nest's Logger so dry-run output stays clean JSON on stdout.
Logger.overrideLogger(false);

export interface DryRunOptions {
  scenarioRef: string;
  inputsFile: string;
  templateId?: string;
  mode: 'live' | 'sandbox';
  packsRoot: string;
}

export async function runDryRun(opts: DryRunOptions): Promise<number> {
  const packsRoot = path.resolve(opts.packsRoot);
  const inputsPath = path.resolve(opts.inputsFile);

  if (!fs.existsSync(inputsPath)) {
    // eslint-disable-next-line no-console
    console.error(`inputs file not found: ${inputsPath}`);
    return 1;
  }

  let inputs: Record<string, unknown>;
  try {
    inputs = JSON.parse(fs.readFileSync(inputsPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`inputs file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const config = {
    packsDir: packsRoot,
    registryCacheTtlMs: 0
  } as AppConfigService;
  const loader = new FileRegistryLoader(config);
  const registryIndex = new RegistryIndexService(loader, config);
  const compiler = new CompilerService(registryIndex);

  try {
    const result = await compiler.compile({
      scenarioRef: opts.scenarioRef,
      templateId: opts.templateId,
      inputs,
      mode: opts.mode
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof AppException) {
      // eslint-disable-next-line no-console
      console.error(`${err.errorCode}: ${err.message}`);
      if (err.metadata) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify(err.metadata, null, 2));
      }
    } else {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
    return 1;
  }
}
