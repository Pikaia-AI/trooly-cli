import { Command } from 'commander';
import { loadProfiles, resolveProfile, useProfile } from '../config/profiles';
import { emit } from '../output/render';
import { logout } from './auth';

export function registerProfile(program: Command): void {
  const profile = program.command('profile').description('Manage gateway and login profiles');
  profile.command('list').action(async (_options, cmd: Command) => {
    const config = await loadProfiles();
    emit(
      Object.entries(config.profiles).map(([name, value]) => ({
        name,
        current: name === config.current_profile,
        ...value,
      })),
      Boolean(cmd.optsWithGlobals().json),
    );
  });
  profile.command('use <name>').action(async (name: string, _options, cmd: Command) => {
    await useProfile(name);
    emit({ current_profile: name }, Boolean(cmd.optsWithGlobals().json));
  });
  profile.command('remove <name>').action(async (name: string, _options, cmd: Command) => {
    await logout(await resolveProfile(name), true);
    emit({ removed: name }, Boolean(cmd.optsWithGlobals().json));
  });
}
