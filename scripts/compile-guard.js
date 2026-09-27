import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const sourcePath = path.resolve('contracts/Fables7702Guard.sol');
const source = fs.readFileSync(sourcePath, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'Fables7702Guard.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  }
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((x) => x.severity === 'error');
if (errors.length) throw new Error(errors.map((x) => x.formattedMessage).join('\n'));
const contract = output.contracts['Fables7702Guard.sol'].Fables7702Guard;
const requiredFunctions = new Set(['guardVersion', 'IMPLEMENTATION', 'guardedWithdrawAndClaim']);
const abiFunctions = new Set(contract.abi.filter((x) => x.type === 'function').map((x) => x.name));
for (const fn of requiredFunctions) {
  if (!abiFunctions.has(fn)) throw new Error(`Compiled guard ABI is missing required function: ${fn}`);
}
const artifact = {
  contractName: 'Fables7702Guard',
  compiler: solc.version(),
  abi: contract.abi,
  bytecode: '0x' + contract.evm.bytecode.object,
  deployedBytecode: '0x' + contract.evm.deployedBytecode.object
};
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/Fables7702Guard.json', JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({ ok: true, compiler: artifact.compiler, bytecodeBytes: (artifact.bytecode.length - 2) / 2 }, null, 2));
