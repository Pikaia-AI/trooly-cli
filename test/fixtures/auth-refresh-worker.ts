import '../network-guard';
import { resolveProfile } from '../../src/config/profiles';
import { ensureAccessToken } from '../../src/auth/tokens';
process.send?.('ready');
process.once('message', async () => {
  try {
    const token = await ensureAccessToken(await resolveProfile(), process.env.REJECTED_FAKE_TOKEN);
    process.send?.({ ok: token === 'fake-access-new' });
    process.disconnect();
  } catch {
    process.exitCode = 1;
    process.send?.({ ok: false });
    process.disconnect();
  }
});
