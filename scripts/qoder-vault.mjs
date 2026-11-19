#!/usr/bin/env node
/**
 * qoder-vault.mjs —— 把 Qoder CN 桌面 App 的登录态导出为 dsh-connect 可读的会话快照。
 *
 * 为什么需要它：
 *   Qoder 的登录态存在桌面 App 的用户数据目录里（Windows: %APPDATA%\com.qodercn.app.stable\）：
 *     Local State     —— Chromium 标准的 os_crypt.encrypted_key（DPAPI 保护的 AES-256 key）
 *     auth.v1.dat     —— 会话 token / refreshToken，用上面那把 key 做的 AES-256-GCM 密文
 *   dsh-connect 的 Qoder provider 读的是明文快照
 *     ~/.dsh/connect-auth/qoder-session.json
 *   会话过期后必须重新从 App 解出最新 token 写回，否则回落 PAT 又报「未配置 PAT」。
 *
 *   插件代码里一直注释说这个文件由 `scripts/qoder-vault.mjs --install-session` 写出，
 *   但脚本本体在发行版里缺失。本脚本补齐这个缺口。
 *
 * 加密格式（已在本机 0.x 实机验证，2026-11-19）：
 *   Local State:  os_crypt.encrypted_key = base64("DPAPI" ‖ DPAPI_protected_32byte_key)
 *   auth.v1.dat:  "v10" ‖ iv[12] ‖ ciphertext ‖ gcmTag[16]   (AES-256-GCM)
 *   Windows 上 DPAPI 解密钥必须用当前用户作用域（CurrentUser）——本脚本通过
 *   spawnSync('pwsh', ...) 调 .NET ProtectedData.Unprotect 完成，密钥只在内存里传递，
 *   不落盘、不打印。Node 侧负责 AES-GCM 解密（.NET Framework 的 pwsh 没有 AesGcm 类型）。
 *
 * 用法：
 *   node scripts/qoder-vault.mjs --check             # 只解密并体检，不写文件（默认脱敏）
 *   node scripts/qoder-vault.mjs --install-session   # 解密并写入 connect-auth/qoder-session.json
 *   node scripts/qoder-vault.mjs --check --full      # 体检时打印完整 token（默认只留前缀）
 *   node scripts/qoder-vault.mjs --app-dir DIR       # 指定 App 数据目录（默认自动探测）
 *   node scripts/qoder-vault.mjs --out FILE          # 自定义会话快照输出路径
 *
 * 安全约定：默认不打印任何 token 原文；只读 App 的 Local State 与 auth.v1.dat，
 * 除 --install-session/--out 指定的快照外不写任何文件。写出的快照权限设为 0600。
 */

import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const APPDATA = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
const APP_DIRS = [
  path.join(APPDATA, 'com.qodercn.app.stable'), // 实测目录名
  path.join(APPDATA, 'QoderCN'),
  path.join(APPDATA, 'Qoder'),
];
const DEFAULT_SESSION = path.join(homedir(), '.dsh', 'connect-auth', 'qoder-session.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const FULL = process.argv.includes('--full');
const CHECK = process.argv.includes('--check');
const INSTALL = process.argv.includes('--install-session') || !CHECK;
const APP_DIR_OVERRIDE = arg('--app-dir', undefined);
const OUT = arg('--out', DEFAULT_SESSION);

function findAppDir() {
  if (APP_DIR_OVERRIDE) {
    if (!existsSync(APP_DIR_OVERRIDE)) fail(`--app-dir 不存在: ${APP_DIR_OVERRIDE}`);
    return APP_DIR_OVERRIDE;
  }
  const hit = APP_DIRS.find((d) => existsSync(path.join(d, 'auth.v1.dat')) && existsSync(path.join(d, 'Local State')));
  if (!hit) fail(`找不到 Qoder App 数据目录（需同时有 auth.v1.dat 与 Local State）。试过:\n  ${APP_DIRS.join('\n  ')}\n用 --app-dir 指定。`);
  return hit;
}

function fail(msg) { console.error('✗ ' + msg); process.exit(2); }

/** 找可用的 PowerShell（pwsh 7 或 Windows PowerShell 5.1）。node 的 spawnSync 可能看不到 DSH 注入的 PATH。 */
function findPowerShell() {
  const candidates = [
    'pwsh', 'powershell',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const c of candidates) {
    const probe = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8', timeout: 15000,
    });
    if (probe.status === 0 && /^\d+$/m.test((probe.stdout || '').trim())) return c;
  }
  fail('找不到可用的 PowerShell（pwsh 或 powershell）。');
}

/** 用 PowerShell 的 .NET ProtectedData 解 DPAPI blob，返回 base64 key（不落盘）。 */
function dpapiUnprotect(blobBase64) {
  if (process.platform !== 'win32') fail('qoder-vault 目前只支持 Windows（DPAPI）。');
  const psExe = findPowerShell();
  const ps = String.raw`
Add-Type -AssemblyName System.Security
$blob = [Convert]::FromBase64String($env:QODER_B64)
$key = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($key)
`;
  const r = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QODER_B64: blobBase64 },
  });
  if (r.status !== 0 || !r.stdout?.trim()) {
    fail(`DPAPI 解密失败: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
  }
  return r.stdout.trim();
}

/** 从 App 数据目录解出会话 JSON。 */
function decryptSession(appDir) {
  const lsPath = path.join(appDir, 'Local State');
  const authPath = path.join(appDir, 'auth.v1.dat');
  let ls;
  try { ls = JSON.parse(readFileSync(lsPath, 'utf8')); }
  catch (e) { fail(`读 Local State 失败: ${e.message}`); }
  const ekB64 = ls?.os_crypt?.encrypted_key;
  if (typeof ekB64 !== 'string' || !ekB64) fail('Local State 里没有 os_crypt.encrypted_key。');

  const ek = Buffer.from(ekB64, 'base64');
  if (ek.subarray(0, 5).toString('ascii') !== 'DPAPI') fail('encrypted_key 不是 DPAPI 前缀（格式可能已变）。');
  const key = Buffer.from(dpapiUnprotect(ek.subarray(5).toString('base64')), 'base64');
  if (key.length !== 32) fail(`解出的 AES key 长度异常: ${key.length}（预期 32）。`);

  const dat = readFileSync(authPath);
  if (dat.subarray(0, 3).toString('ascii') !== 'v10') fail(`auth.v1.dat 前缀不是 v10: ${dat.subarray(0, 3).toString('ascii')}（格式可能已变）。`);
  const iv = dat.subarray(3, 15);
  const enc = dat.subarray(15);
  const tag = enc.subarray(enc.length - 16);
  const cipher = enc.subarray(0, enc.length - 16);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  let plain;
  try { plain = Buffer.concat([d.update(cipher), d.final()]); }
  catch (e) { fail(`AES-GCM 解密失败（密钥或格式不对）: ${e.message}`); }
  let session;
  try { session = JSON.parse(plain.toString('utf8')); }
  catch (e) { fail(`解密结果不是 JSON: ${e.message}`); }
  return session;
}

/** 把 App 会话结构整理成 dsh-connect 期望的 qoder-session.json。 */
function toSessionDoc(s) {
  const uid = s.user?.id ?? s.uid ?? '';
  const token = s.token ?? '';
  if (!uid || !token) fail('解密出的会话缺 token 或 user.id。');
  return {
    token,
    refreshToken: s.refreshToken ?? '',
    expiresAt: s.expiresAt ?? '',
    refreshTokenExpiresAt: s.refreshTokenExpiresAt ?? '',
    uid,
    name: s.user?.name ?? s.name ?? '',
    email: s.user?.email ?? s.email ?? '',
    importedAt: new Date().toISOString(),
    source: 'Qoder CN desktop auth.v1.dat (Electron OSCrypt/DPAPI, via qoder-vault.mjs)',
  };
}

const mask = (t) => (typeof t === 'string' && t.length > 16 ? `${t.slice(0, 10)}…(${t.length} 字符)` : t);

const appDir = findAppDir();
const session = decryptSession(appDir);
const doc = toSessionDoc(session);
const exp = doc.expiresAt ? Date.parse(doc.expiresAt) : 0;
const stillValid = exp > Date.now();

console.log('Qoder 会话快照');
console.log(`  App 目录   : ${appDir}`);
console.log(`  账号       : ${doc.name}  (uid ${doc.uid})`);
console.log(`  token      : ${FULL ? doc.token : mask(doc.token)}`);
console.log(`  refresh    : ${FULL ? doc.refreshToken : mask(doc.refreshToken)}`);
console.log(`  token 到期 : ${doc.expiresAt || '?'}  ${stillValid ? '（有效）' : '（已过期）'}`);
console.log(`  refresh 到期: ${doc.refreshTokenExpiresAt || '?'}`);

if (CHECK) {
  console.log('\n--check 模式：未写入任何文件。');
  process.exit(0);
}

if (INSTALL) {
  const dir = path.dirname(OUT);
  if (!existsSync(dir)) fail(`输出目录不存在: ${dir}`);
  // 备份旧的（如果存在且内容不同）
  if (existsSync(OUT)) {
    const old = readFileSync(OUT, 'utf8');
    if (old !== JSON.stringify(doc, null, 2)) {
      try { writeFileSync(OUT + '.bak', old); } catch { /* 备份失败不阻断 */ }
    }
  }
  writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(OUT, 0o600); } catch { /* Windows 上 chmod 可能无效 */ }
  console.log(`\n已写入 (0600): ${OUT}`);
  console.log('插件按 30 秒一轮巡检重读凭据，不用重启 DSH。');
}
