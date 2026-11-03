import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { bundledSkillDirectory } from '../package';

export function guide(): string {
  const skill = readFileSync(join(bundledSkillDirectory(), 'SKILL.md'), 'utf8');
  return skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

export function registerGuide(program: Command): void {
  program
    .command('guide')
    .description('Print the Markdown guide for AI assistants')
    .action(() => {
      process.stdout.write(guide());
    });
}
