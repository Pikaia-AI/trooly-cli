// Tests are confined to loopback servers, including OAuth and registry fixtures.
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Test attempted a non-loopback network request.');
  }
  return localFetch(input, {
    ...init,
    redirect: init?.redirect ?? (input instanceof Request ? input.redirect : 'error'),
  });
};
