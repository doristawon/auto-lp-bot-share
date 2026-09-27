import fs from 'node:fs';
import { Interface, Wallet, getAddress, id } from 'ethers';
import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createProviders, verifyProviders } from '../rpc/providers.js';
import { ZERO_ADDRESS } from '../constants.js';

loadDotEnv();
const config = loadConfig();
if (!config.privateKey) throw new Error('PRIVATE_KEY is required');
const { writeProvider, rawProviders } = createProviders(config);
await verifyProviders(rawProviders, config.chainId);
const wallet = new Wallet(config.privateKey, writeProvider);
if (wallet.address.toLowerCase() !== config.walletAddress.toLowerCase()) throw new Error('PRIVATE_KEY does not match WALLET_ADDRESS');

const revoke = process.argv.includes('--revoke');
const guardAddress = revoke ? ZERO_ADDRESS : getAddress(config.eip7702GuardAddress || '');
if (!revoke) {
  const code = await writeProvider.getCode(guardAddress);
  if (!code || code === '0x') throw new Error('EIP7702_GUARD_ADDRESS has no deployed code');
}
const txNonce = await wallet.getNonce('pending');
const authorization = await wallet.authorize({
  address: guardAddress,
  chainId: config.chainId,
  nonce: txNonce + 1
});
let data = '0x';
if (!revoke) {
  const artifact = JSON.parse(fs.readFileSync('artifacts/Fables7702Guard.json', 'utf8'));
  data = new Interface(artifact.abi).encodeFunctionData('guardVersion', []);
}
const tx = await wallet.sendTransaction({
  to: wallet.address,
  data,
  nonce: txNonce,
  type: 4,
  authorizationList: [authorization]
});
console.log(JSON.stringify({ sent: tx.hash, revoke, guardAddress }, null, 2));
const receipt = await tx.wait(config.confirmations);
if (!receipt || receipt.status !== 1) throw new Error('EIP-7702 setup transaction failed');
const code = (await writeProvider.getCode(wallet.address)).toLowerCase();
const expected = revoke ? '0x' : ('0xef0100' + guardAddress.slice(2)).toLowerCase();
if (code !== expected) throw new Error(`Delegation verification failed: expected ${expected}, got ${code}`);
if (!revoke) {
  const artifact = JSON.parse(fs.readFileSync('artifacts/Fables7702Guard.json', 'utf8'));
  const iface = new Interface(artifact.abi);
  const versionRaw = await writeProvider.call({
    from: wallet.address,
    to: wallet.address,
    data: iface.encodeFunctionData('guardVersion', [])
  });
  const [version] = iface.decodeFunctionResult('guardVersion', versionRaw);
  const expectedVersion = id('Fables7702Guard/v1');
  if (String(version).toLowerCase() !== expectedVersion.toLowerCase()) {
    throw new Error(`Guard version mismatch after delegation: expected ${expectedVersion}, got ${version}`);
  }
  const implRaw = await writeProvider.call({
    from: wallet.address,
    to: wallet.address,
    data: iface.encodeFunctionData('IMPLEMENTATION', [])
  });
  const [implementation] = iface.decodeFunctionResult('IMPLEMENTATION', implRaw);
  if (String(implementation).toLowerCase() !== guardAddress.toLowerCase()) {
    throw new Error(`Guard implementation mismatch after delegation: expected ${guardAddress}, got ${implementation}`);
  }
}
console.log(JSON.stringify({ ok: true, wallet: wallet.address, code }, null, 2));
