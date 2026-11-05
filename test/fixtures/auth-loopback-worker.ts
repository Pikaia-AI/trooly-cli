import { loopbackLogin } from '../../src/auth/loopback';
import type { OAuthMetadata } from '../../src/types/oauth';

const base = process.argv[2];
if (new URL(base).hostname !== '127.0.0.1') throw new Error('Expected a loopback fixture');
const metadata: OAuthMetadata = {
  issuer: base,
  authorization_endpoint: `${base}/authorize`,
  token_endpoint: `${base}/token`,
  revocation_endpoint: `${base}/revoke`,
  device_authorization_endpoint: `${base}/device`,
};
try {
  await loopbackLogin(base, metadata, {
    onAuthorize: (url) => {
      process.send?.({ authorize: url });
    },
  });
  process.exitCode = 0;
} catch {
  process.exitCode = 3;
} finally {
  // The process must exit on its own after IPC is released. A leftover HTTP
  // socket will keep it alive and fail the parent test.
  process.disconnect();
}
