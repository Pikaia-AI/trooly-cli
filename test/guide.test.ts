import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { guide } from '../src/commands/guide';
import { main } from '../src/index';
import { bundledSkillDirectory } from '../src/package';

async function readSkill() {
  const content = await readFile(join(bundledSkillDirectory(), 'SKILL.md'), 'utf8');
  const lines = content.split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end).toBeGreaterThan(1);
  return {
    frontmatter: parse(lines.slice(1, end).join('\n')),
    body: lines.slice(end + 1).join('\n'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('bundled assistant skill', () => {
  it('has Agent Skills metadata and supplies the entire guide body', async () => {
    const skill = await readSkill();
    expect(skill.frontmatter.name).toBe('trooly');
    expect(skill.frontmatter.description).toEqual(expect.any(String));
    expect(skill.frontmatter.description.length).toBeGreaterThan(0);
    expect(guide()).toBe(skill.body);
    expect(guide()).toContain('trooly auth status --json');
  });

  it('prints only the skill body without reading a profile or making requests', async () => {
    vi.stubEnv('TROOLY_NO_UPDATE_CHECK', '1');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
      output.push(String(data));
      return true;
    });
    expect(await main(['node', 'trooly', '--profile', 'missing-profile', 'guide'])).toBe(0);
    expect(output.join('')).toBe((await readSkill()).body);
    expect(fetch).not.toHaveBeenCalled();
  });
});
