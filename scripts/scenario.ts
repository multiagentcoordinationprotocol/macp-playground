#!/usr/bin/env ts-node
import { Command } from 'commander';

async function main(): Promise<void> {
  const program = new Command();
  // `-V, --cli-version` rather than commander's default `-V, --version`. The default long flag
  // SHADOWS the `new` subcommand's own `--version <semver>` option (declared below), and commander
  // resolves the collision in favour of the program: `scenario new demo my-sample --version 1.2.3`
  // printed `0.2.0`, exited 0, and scaffolded nothing. Reproduced on commander 4.1.1 and 15.0.0 —
  // on 15 it raises CommanderError code=commander.version, still exitCode 0. `docs/scenario-cli.md`
  // has documented `[--version 1.0.0]` as working since the CLI was written; it never has.
  //
  // Renaming the PROGRAM's flag is the fix that keeps the documented surface intact. Rejected:
  // renaming the subcommand's option to `--scenario-version` (breaks the published surface to work
  // around an internal collision), and deleting `program.version()` (works, but silently drops the
  // version flag from `--help`).
  program.name('scenario').description('Authoring CLI for MACP scenario packs').version('0.2.0', '-V, --cli-version');

  program
    .command('validate <path>')
    .description('Validate a scenario.yaml: structure, JSON Schema, fixtures, placeholders, agentRefs')
    .option('--packs-root <dir>', 'root packs directory (defaults to ./packs)', 'packs')
    .action(async (target: string, opts: { packsRoot: string }) => {
      const { runValidate } = await import('./scenario/validate');
      const code = await runValidate({ target, packsRoot: opts.packsRoot });
      process.exit(code);
    });

  program
    .command('dry-run <scenarioRef>')
    .description('Compile a scenario offline and print the resulting ExecutionRequest')
    .requiredOption('--inputs <file>', 'path to a JSON file containing user inputs')
    .option('--template <slug>', 'optional template slug to apply')
    .option('--mode <mode>', 'live or sandbox (default: sandbox)', 'sandbox')
    .option('--packs-root <dir>', 'root packs directory (defaults to ./packs)', 'packs')
    .action(
      async (scenarioRef: string, opts: { inputs: string; template?: string; mode: string; packsRoot: string }) => {
        const { runDryRun } = await import('./scenario/dry-run');
        const code = await runDryRun({
          scenarioRef,
          inputsFile: opts.inputs,
          templateId: opts.template,
          mode: opts.mode === 'live' ? 'live' : 'sandbox',
          packsRoot: opts.packsRoot
        });
        process.exit(code);
      }
    );

  program
    .command('new <pack> <scenario>')
    .description('Scaffold a new scenario directory tree')
    .option('--version <semver>', 'scenario version', '1.0.0')
    .option('--from <scenarioRef>', 'copy an existing scenario as the starting point')
    .option('--packs-root <dir>', 'root packs directory (defaults to ./packs)', 'packs')
    .action(async (pack: string, scenario: string, opts: { version: string; from?: string; packsRoot: string }) => {
      const { runNew } = await import('./scenario/new');
      const code = await runNew({
        pack,
        scenario,
        version: opts.version,
        fromScenarioRef: opts.from,
        packsRoot: opts.packsRoot
      });
      process.exit(code);
    });

  program
    .command('lint <target>')
    .description('Run static checks across one or more packs')
    .option('--packs-root <dir>', 'root packs directory (defaults to ./packs)', 'packs')
    .action(async (target: string, opts: { packsRoot: string }) => {
      const { runLint } = await import('./scenario/lint');
      const code = await runLint({ target, packsRoot: opts.packsRoot });
      process.exit(code);
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
