#!/usr/bin/env node

import { Command } from 'commander';
import { patchDroid } from './patcher.js';
import { createAlias, removeAlias, listAliases } from './alias.js';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('droid-patch')
  .description('CLI tool to patch droid binary with various modifications')
  .version(pkg.version);

program
  .argument('<alias>', 'Alias name for the patched binary (e.g., "droid-custom")')
  .option('--is-custom', 'Patch isCustom:!0 to isCustom:!1 (enable context compression for custom models)')
  .option('--dry-run', 'Verify patches without actually modifying the binary')
  .option('-p, --path <path>', 'Path to the droid binary', findDefaultDroidPath())
  .option('-o, --output <path>', 'Output path for patched binary (default: <path>.patched)')
  .option('--no-backup', 'Skip creating backup of original binary')
  .option('-v, --verbose', 'Enable verbose output')
  .action(async (alias, options) => {
    console.log(chalk.cyan('═'.repeat(60)));
    console.log(chalk.cyan.bold('  Droid Binary Patcher'));
    console.log(chalk.cyan('═'.repeat(60)));
    console.log();

    // Validate that at least one patch flag is provided
    if (!options.isCustom) {
      console.log(chalk.yellow('No patch flags specified. Available patches:'));
      console.log(chalk.gray('  --is-custom    Patch isCustom for custom models'));
      console.log();
      console.log(chalk.white('Usage examples:'));
      console.log(chalk.cyan('  npx droid-patch --is-custom droid-custom'));
      console.log(chalk.cyan('  npx droid-patch --is-custom --dry-run droid-custom'));
      process.exit(1);
    }

    const patches = [];
    if (options.isCustom) {
      patches.push({
        name: 'isCustom',
        description: 'Change isCustom:!0 to isCustom:!1',
        pattern: Buffer.from('isCustom:!0'),
        replacement: Buffer.from('isCustom:!1'),
      });
    }

    try {
      const result = await patchDroid({
        inputPath: options.path,
        outputPath: options.output,
        patches,
        dryRun: options.dryRun,
        backup: options.backup,
        verbose: options.verbose,
      });

      if (options.dryRun) {
        console.log();
        console.log(chalk.blue('═'.repeat(60)));
        console.log(chalk.blue.bold('  DRY RUN COMPLETE'));
        console.log(chalk.blue('═'.repeat(60)));
        console.log();
        console.log(chalk.gray('To apply the patches, run without --dry-run:'));
        console.log(chalk.cyan(`  npx droid-patch --is-custom ${alias}`));
        process.exit(0);
      }

      // Create alias
      if (result.success) {
        console.log();
        await createAlias(result.outputPath, alias, options.verbose);
      }

      if (result.success) {
        console.log();
        console.log(chalk.green('═'.repeat(60)));
        console.log(chalk.green.bold('  PATCH SUCCESSFUL'));
        console.log(chalk.green('═'.repeat(60)));
      }

      process.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      if (options.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// Subcommand: list aliases
program
  .command('list')
  .description('List all droid-patch aliases')
  .action(async () => {
    await listAliases();
  });

// Subcommand: remove alias
program
  .command('remove <alias>')
  .description('Remove a droid-patch alias')
  .action(async (alias) => {
    await removeAlias(alias);
  });

function findDefaultDroidPath() {
  // Try common locations
  const home = homedir();
  const paths = [
    join(home, '.droid/bin/droid'),
    '/usr/local/bin/droid',
    './droid',
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return join(home, '.droid/bin/droid');
}

program.parse();
