import { Command } from 'commander';
import {
  resolveProfile,
  saveProfile,
  removeProfile,
  type ResolvedProfile,
} from '../config/profiles';
import { ApiClient } from '../http/client';
import { CliError } from '../http/errors';
import { emit } from '../output/render';
import { chooseLoginMethod, deviceLogin } from '../auth/device';
import { loopbackLogin } from '../auth/loopback';
import { clientId, discoverOAuth, postOAuth } from '../auth/oauth';
import { credentialStore } from '../auth/store';
import { assertProfileGateway, resolveLockedProfile, withProfileLock } from '../auth/tokens';
import type { Credential } from '../types/credential';

export async function logout(profile: ResolvedProfile, remove = false): Promise<void> {
  await withProfileLock(profile.name, async () => {
    // A mismatch must escape before the cleanup block: these may now be another
    // gateway's credentials, which this stale command must neither send nor erase.
    const current = await resolveLockedProfile(profile, false);
    try {
      const tokens = current.stored ? await credentialStore.read(profile.name) : undefined;
      if (tokens) {
        const metadata = await discoverOAuth(profile.apiBase);
        await postOAuth(metadata.revocation_endpoint, {
          token: tokens.refresh_token,
          token_type_hint: 'refresh_token',
          client_id: clientId(profile.apiBase),
        });
      }
    } catch {
      process.stderr.write(
        'Could not revoke the remote authorization. Local credentials were removed; disconnect this CLI in Connected applications.\n',
      );
    } finally {
      await credentialStore.remove(profile.name);
    }
    if (remove) await removeProfile(profile.name);
  });
}

function loginCommand(command: Command): void {
  command
    .option('--device', 'Use a device code')
    .option('--scope <scope>', 'Requested OAuth scopes', 'read write')
    .action(async (_options, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const profile = await resolveProfile(opts.profile);
      assertProfileGateway(profile);
      const metadata = await discoverOAuth(profile.apiBase);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      try {
        const options = { scope: opts.scope as string, signal: controller.signal };
        const tokens =
          chooseLoginMethod(opts.device) === 'device'
            ? await deviceLogin(profile.apiBase, metadata, options)
            : await loopbackLogin(profile.apiBase, metadata, options);
        const client = new ApiClient({
          apiBase: profile.apiBase,
          profileName: profile.name,
          token: tokens.access_token,
        });
        const result = await client.request('GET', '/platform/v2/credential');
        const identity = result.data as Credential;
        if (
          !identity?.credential?.environment ||
          !identity.organization?.id ||
          !identity.principal?.id
        ) {
          throw new CliError(
            'Invalid credential identity response.',
            1,
            'INVALID_CREDENTIAL_RESPONSE',
          );
        }
        await withProfileLock(profile.name, async () => {
          const current = await resolveLockedProfile(profile, false);
          // An interrupted/removed profile must not attach orphaned old tokens to
          // newly written gateway metadata if persisting the new tokens fails.
          if (!current.stored) await credentialStore.remove(profile.name);
          await saveProfile(profile.name, {
            api_base: profile.apiBase,
            auth: 'oauth',
            organization: identity.organization,
            environment: identity.credential.environment,
            principal: identity.principal,
            logged_in_at: new Date().toISOString(),
          });
          await credentialStore.write(profile.name, tokens);
        });
        emit(identity, Boolean(opts.json));
      } catch (error) {
        if (controller.signal.aborted) throw new CliError('Login cancelled.', 3, 'LOGIN_CANCELLED');
        throw error;
      } finally {
        process.removeListener('SIGINT', cancel);
      }
    });
}
function logoutCommand(command: Command): void {
  command.action(async (_options, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    const profile = await resolveProfile(opts.profile);
    await logout(profile);
    emit({ profile: profile.name, logged_out: true }, Boolean(opts.json));
  });
}
function statusCommand(command: Command): void {
  command.action(async (_options, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    const profile = await resolveProfile(opts.profile);
    const result = await new ApiClient({
      apiBase: profile.apiBase,
      profileName: profile.name,
    }).request('GET', '/platform/v2/credential');
    if (opts.json) emit(result.data, true);
    else {
      emit(
        { profile: profile.name, gateway: profile.apiBase, ...(result.data as Credential) },
        false,
      );
    }
  });
}
export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');
  loginCommand(auth.command('login').description('Log in with OAuth'));
  loginCommand(program.command('login').description('Log in with OAuth'));
  logoutCommand(
    auth.command('logout').description('Revoke authorization and clear local credentials'),
  );
  logoutCommand(
    program.command('logout').description('Revoke authorization and clear local credentials'),
  );
  statusCommand(auth.command('status').description('Show the current credential identity'));
  statusCommand(
    program.command('whoami').description('Show the current account, organization and environment'),
  );
}
