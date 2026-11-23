import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

test('assembled provisioning loads X509 with the same ASN schema registry', async () => {
  const client = createRequire(new URL('../build/app/package.json', import.meta.url));
  const core = createRequire(client.resolve('@nexusaos/local-provisioning-core'));
  const x509 = createRequire(core.resolve('@peculiar/x509'));
  const rsa = createRequire(x509.resolve('@peculiar/asn1-rsa'));
  const algorithms = createRequire(x509.resolve('@peculiar/asn1-x509'));
  assert.equal(rsa.resolve('@peculiar/asn1-schema'), algorithms.resolve('@peculiar/asn1-schema'));
  assert.equal(rsa.resolve('@peculiar/asn1-x509'), x509.resolve('@peculiar/asn1-x509'));
  assert.doesNotThrow(() => core('@peculiar/x509'));
  await assert.doesNotReject(import(pathToFileURL(client.resolve('@nexusaos/local-provisioning-core/node'))));
});
