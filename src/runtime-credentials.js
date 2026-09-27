import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const PERSISTED_KEYS = new Set(['RPC_URLS', 'WALLET_ADDRESS', 'PRIVATE_KEY']);

export function persistRuntimeCredentials({ rpcUrls, walletAddress, privateKey }, {
  enabled = false,
  filePath = path.resolve('.env')
} = {}) {
  if (!enabled) return false;

  const target = path.resolve(filePath);
  let current;
  try {
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error();
    current = fs.readFileSync(target, 'utf8');
  } catch {
    throw new Error('本機 .env 無法安全讀取，憑證尚未保存。');
  }

  const values = {
    RPC_URLS: (rpcUrls || []).join(','),
    WALLET_ADDRESS: walletAddress || '',
    PRIVATE_KEY: privateKey || ''
  };
  for (const key of PERSISTED_KEYS) {
    if (/[\r\n\0]/.test(values[key])) throw new Error('本機 .env 更新內容無效，憑證尚未保存。');
  }

  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const found = new Set();
  const lines = current.split(/\r?\n/).map((line) => {
    const equals = line.indexOf('=');
    if (equals < 1) return line;
    const key = line.slice(0, equals).trim();
    if (!PERSISTED_KEYS.has(key)) return line;
    found.add(key);
    return `${line.slice(0, equals + 1)}${values[key]}`;
  });
  for (const key of PERSISTED_KEYS) {
    if (!found.has(key)) lines.push(`${key}=${values[key]}`);
  }
  const content = lines.join(newline);
  const temp = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;

  try {
    fs.copyFileSync(target, temp, fs.constants.COPYFILE_EXCL);
    secureCredentialFile(temp);
    fs.writeFileSync(temp, content, 'utf8');
    secureCredentialFile(temp);
    fs.renameSync(temp, target);
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    return true;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw new Error('本機 .env 寫入失敗，未切換目前的錢包或 RPC。');
  }
}

function secureCredentialFile(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME?.trim();
    const domain = process.env.USERDOMAIN?.trim();
    if (!user) throw new Error('Current Windows user is unavailable');
    const account = domain ? `${domain}\\${user}` : user;
    execFileSync('icacls', [
      path.resolve(file), '/inheritance:r',
      '/grant:r', `${account}:(F)`,
      '/grant', '*S-1-5-18:(F)',
      '/grant', '*S-1-5-32-544:(F)'
    ], { stdio: 'ignore', windowsHide: true });
    return;
  }
  fs.chmodSync(file, 0o600);
}
