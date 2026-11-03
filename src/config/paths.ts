import { homedir } from 'node:os';
import { join } from 'node:path';

export function getPaths(
  env = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
) {
  const configDir = join(
    platform === 'win32'
      ? env.APPDATA || join(home, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || join(home, '.config'),
    'trooly',
  );
  const cacheDir = join(
    platform === 'win32'
      ? env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      : env.XDG_CACHE_HOME || join(home, '.cache'),
    'trooly',
  );
  return {
    configDir,
    cacheDir,
    configFile: join(configDir, 'config.json'),
    credentialsFile: join(configDir, 'credentials.json'),
  };
}
