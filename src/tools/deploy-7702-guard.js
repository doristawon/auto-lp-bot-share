import fs from 'node:fs';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { loadDotEnv } from '../env.js';

loadDotEnv();
if (String(process.env.DEPLOY_EIP7702_GUARD || '').toLowerCase() !== 'true') {
  throw new Error('Set DEPLOY_EIP7702_GUARD=true to explicitly allow guard deployment');
}
const rpc = process.env.GUARD_RPC_URL?.trim() || process.env.RPC_URLS?.split(',')[0]?.trim();
const key = process.env.GUARD_DEPLOYER_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
if (!rpc) throw new Error('GUARD_RPC_URL or RPC_URLS is required');
if (!key) throw new Error('GUARD_DEPLOYER_PRIVATE_KEY or PRIVATE_KEY is required');
if (!fs.existsSync('artifacts/Fables7702Guard.json')) {
  throw new Error('Run npm run compile:guard first');
}
const provider = new JsonRpcProvider(rpc);
const wallet = new Wallet(key, provider);
const network = await provider.getNetwork();
const artifact = JSON.parse(fs.readFileSync('artifacts/Fables7702Guard.json', 'utf8'));
const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const contract = await factory.deploy();
console.log(JSON.stringify({ sent: contract.deploymentTransaction()?.hash || null, deployer: wallet.address, chainId: Number(network.chainId) }, null, 2));
await contract.waitForDeployment();
const address = await contract.getAddress();
const code = await provider.getCode(address);
if (!code || code === '0x') throw new Error('Guard deployment has no runtime code');
console.log(JSON.stringify({ ok: true, guardAddress: address, runtimeBytes: (code.length - 2) / 2 }, null, 2));
