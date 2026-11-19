import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Failure } from '../output.js';
import { run } from './common.js';

/** Root of the MSYS2 install that `screen-relay install` sets up on Windows. */
export const MSYS2_ROOT = 'C:\\msys64';

/** MSYS2's bash, which runs build commands in its UCRT64 environment. Every caller reaches it through msys2Shell, which checks the installation first. */
const MSYS2_SHELL = `${MSYS2_ROOT}\\usr\\bin\\bash.exe`;

/** MSYS2's UCRT64 libraries, which relay-engine loads on Windows. */
const MSYS2_LIBRARIES = `${MSYS2_ROOT}\\ucrt64\\bin`;

/** The directories that the MSYS2 shell searches for the commands setup runs, in its own search order. */
const MSYS2_SEARCH = ['usr/local/bin', 'usr/bin', 'ucrt64/bin'];

/** The PATH that setup gives the MSYS2 shell, so it searches only the directories setup checks and whatever its login profile adds is not used. */
export const MSYS2_PATH = MSYS2_SEARCH.map((directory) => `/${directory}`).join(':');

/** The login scripts that MSYS2's shell reads before it runs a setup command. */
const MSYS2_LOGIN = ['etc\\profile', 'etc\\bash.bashrc'].map((file) => `${MSYS2_ROOT}\\${file}`);

/** The directory whose immediate scripts the login shell runs. */
const MSYS2_PROFILE_D = `${MSYS2_ROOT}\\etc\\profile.d`;

/** Returns the MSYS2 root and every directory from the root down to a path, so a rule on a parent cannot replace it. */
function withParents(path: string): string[] {
  const parts = path.slice(MSYS2_ROOT.length + 1).split('\\');
  return [MSYS2_ROOT, ...parts.map((_, index) => `${MSYS2_ROOT}\\${parts.slice(0, index + 1).join('\\')}`)];
}

/** The commands setup starts or asks the MSYS2 shell to run. */
const MSYS2_COMMANDS = ['bash', 'bash.exe', 'sh', 'sh.exe', 'make', 'make.exe', 'pacman', 'pacman.exe', 'pacman-key', 'pacman-key.exe',
  'gpg', 'gpg.exe', 'gpgconf', 'gpgconf.exe', 'diff', 'diff.exe', 'gcc', 'gcc.exe', 'g++', 'g++.exe',
  'pkgconf', 'pkgconf.exe', 'pkg-config', 'pkg-config.exe'];

/** The Windows directories in MSYS2_PATH. */
const MSYS2_DIRECTORIES = MSYS2_SEARCH.map((directory) => `${MSYS2_ROOT}\\${directory.replaceAll('/', '\\')}`);

/** The command files setup expects in the searched directories. */
const MSYS2_COMMAND_PATHS = MSYS2_DIRECTORIES.flatMap((directory) => MSYS2_COMMANDS.map((command) => `${directory}\\${command}`));

/** The MSYS2 paths that setup starts or searches: the shell, login scripts, command files, and directories in MSYS2_PATH. */
export const MSYS2_CHECKED = [...new Set([
  ...withParents(MSYS2_SHELL),
  ...MSYS2_LOGIN.flatMap((path) => withParents(path)),
  ...withParents(MSYS2_PROFILE_D),
  ...MSYS2_DIRECTORIES.flatMap((directory) => withParents(directory)),
  ...MSYS2_COMMAND_PATHS.flatMap((path) => withParents(path)),
])];

/** Owners that setup trusts besides the signed-in account: SYSTEM, Administrators, and TrustedInstaller. */
const TRUSTED_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']);

/** FILE_WRITE_DATA, FILE_DELETE_CHILD, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, and GENERIC_WRITE: the rights that let an account replace a path or alter the files in it. Creating a subdirectory cannot replace the shell, so FILE_APPEND_DATA is not one of them on a directory. */
const REPLACE_RIGHTS = 0x2 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;

/** The rights that let an account alter a path, by kind of object: on a file FILE_APPEND_DATA adds to its contents, which is how another account runs code from a profile that `bash -l` reads, while on a directory the same bit only adds a subdirectory. */
const WRITE_RIGHTS: Record<AclObject['kind'], number> = { file: REPLACE_RIGHTS | 0x4, directory: REPLACE_RIGHTS };

/** Rules that only apply to objects their trustee creates; who may create them is already settled by the parent's rules. */
const CREATOR_SIDS = new Set(['S-1-3-0', 'S-1-3-1', 'S-1-3-4']);

/** The decision this process made about the MSYS2 installation, so setup checks the tree once rather than for every step. */
let installation: Msys2Installation | undefined;

/** One access rule as PowerShell reports it: the trustee's security identifier, its account name, and the rights it is granted. */
export type AclRule = { sid: string; name: string; rights: number };

/** The owner and allow rules of one path, whether it is a directory or a file, and whether it is a reparse point. */
export type AclObject = { path: string; kind: 'file' | 'directory'; reparse: boolean; owner: string; ownerName: string; rules: AclRule[] };

/** The allow rules of the MSYS2 paths, and the security identifier of the signed-in account. */
export type AclProbe = { current: string; objects: AclObject[] };

/** What setup found at the MSYS2 root: an absent root, an installation it runs, or a tree it will not run. */
export type Msys2Installation =
  | { state: 'missing'; root: string }
  | { state: 'trusted'; root: string; shell: string }
  | { state: 'untrusted'; root: string; reason: string };

/** The MSYS2 states that stop setup. */
export type Msys2Problem = Exclude<Msys2Installation, { state: 'trusted' }>;

/** The environment that runs relay-engine, with MSYS2's UCRT64 libraries first on PATH on Windows. Other platforms get the environment unchanged. */
export function engineEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== 'win32' || msys2Installation().state !== 'trusted') return env;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...env, [key]: [MSYS2_LIBRARIES, env[key]].filter(Boolean).join(';') };
}

/** The directory to start the engine in on Windows: its own, so Windows does not search the caller's folder for the engine's DLLs. Undefined elsewhere. */
export function engineWorkingDirectory(engine: string): string | undefined {
  return process.platform === 'win32' ? dirname(engine) : undefined;
}

/** The MSYS2 installation on this machine, decided once per process. Call forgetMsys2Installation after setup changes the tree. */
export function msys2Installation(): Msys2Installation {
  installation ??= detectMsys2();
  return installation;
}

/** Drops the remembered decision, so the next check reads the installation again. */
export function forgetMsys2Installation(): void {
  installation = undefined;
}

/** MSYS2's bash, after checking that setup trusts the installation it comes from. */
export function msys2Shell(): string {
  const found = msys2Installation();
  if (found.state === 'trusted') return found.shell;
  throw msys2Failure(found);
}

/** The failure that says setup will not run the MSYS2 tree it found, and what to do about it. The hint carries no backticks, because the CLI prints a backticked command in place of the hint. */
export function msys2Failure(found: Msys2Problem): Failure {
  if (found.state === 'untrusted') return new Failure('missing_dependency', `MSYS2 at ${found.root} is not a trusted installation`, msys2Fix(found));
  return new Failure('missing_dependency', 'MSYS2 is not installed', 'Run screen-relay install to create and install MSYS2 with the access rules it checks.');
}

/** The fix for an MSYS2 tree that setup will not run: delete it so setup can install a fresh copy. */
export function msys2Fix(found: Extract<Msys2Installation, { state: 'untrusted' }>): string {
  return `${found.reason} Back up any files you need. Delete ${found.root} and run screen-relay install again.`;
}

/** Whether the signed-in account, SYSTEM, Administrators, or TrustedInstaller owns every MSYS2 path that setup runs or loads, and no other account can write to it. */
export function trustedAcl(probe: AclProbe): { trusted: true } | { trusted: false; reason: string } {
  const trusted = (sid: string) => Boolean(sid) && (sid === probe.current || TRUSTED_SIDS.has(sid));
  for (const object of probe.objects) {
    if (object.reparse) return { trusted: false, reason: `${object.path} is a reparse point.` };
    if (!trusted(object.owner)) return { trusted: false, reason: `${object.path} is owned by ${object.ownerName}.` };
    for (const rule of object.rules) {
      if (!(rule.rights & WRITE_RIGHTS[object.kind]) || trusted(rule.sid) || CREATOR_SIDS.has(rule.sid)) continue;
      return { trusted: false, reason: `${object.path} lets ${rule.name} write to it.` };
    }
  }
  return { trusted: true };
}

/** Reads what the machine has at the MSYS2 root and whether setup trusts the shell it would run. */
function detectMsys2(): Msys2Installation {
  if (!existsSync(MSYS2_ROOT)) return { state: 'missing', root: MSYS2_ROOT };
  if (!existsSync(MSYS2_SHELL)) return { state: 'untrusted', root: MSYS2_ROOT, reason: `${MSYS2_ROOT} does not contain the MSYS2 shell.` };
  const probe = aclProbe(true);
  if (!probe) return { state: 'untrusted', root: MSYS2_ROOT, reason: `screen-relay could not read the owner and access rules of ${MSYS2_ROOT}.` };
  const verdict = trustedAcl(probe);
  return verdict.trusted
    ? { state: 'trusted', root: MSYS2_ROOT, shell: MSYS2_SHELL }
    : { state: 'untrusted', root: MSYS2_ROOT, reason: verdict.reason };
}

/** The icacls arguments that give a new MSYS2 root its access rules. */
function privateMsys2Acl(account: string): string[] {
  return [MSYS2_ROOT, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${account}:(OI)(CI)F`, '*S-1-5-32-545:(OI)(CI)RX'];
}

/** Creates a private MSYS2 root and returns a function that removes that same root if it is still empty. */
export function createPrivateMsys2Root(): (() => boolean) | null {
  if (process.platform !== 'win32') return null;
  try {
    mkdirSync(MSYS2_ROOT);
  } catch {
    return null;
  }
  let identity: { dev: bigint; ino: bigint };
  try {
    const root = lstatSync(MSYS2_ROOT, { bigint: true });
    if (!root.isDirectory() || root.ino === 0n) return null;
    identity = { dev: root.dev, ino: root.ino };
  } catch {
    return null;
  }
  const discard = () => {
    try {
      const root = lstatSync(MSYS2_ROOT, { bigint: true });
      if (!root.isDirectory() || root.dev !== identity.dev || root.ino !== identity.ino) return false;
      rmdirSync(MSYS2_ROOT);
      return true;
    } catch {
      return false;
    } finally {
      forgetMsys2Installation();
    }
  };
  const fail = () => { discard(); return null; };
  const emptyBefore = (() => {
    try { return readdirSync(MSYS2_ROOT).length === 0; } catch { return false; }
  })();
  if (!emptyBefore) return fail();
  const first = aclProbe();
  if (!first || !/^S-\d+(-\d+)+$/.test(first.current)) return fail();
  if (first.objects.some((object) => object.reparse)) return fail();
  const emptyBeforeAcl = (() => {
    try { return readdirSync(MSYS2_ROOT).length === 0; } catch { return false; }
  })();
  if (!emptyBeforeAcl) return fail();
  const applied = run([systemTool('icacls.exe'), ...privateMsys2Acl(first.current)], { timeout: 120000 }).status === 0;
  const probe = aclProbe();
  const emptyAfter = (() => {
    try { return readdirSync(MSYS2_ROOT).length === 0; } catch { return false; }
  })();
  forgetMsys2Installation();
  if (!applied || !probe || !trustedAcl(probe).trusted || !emptyAfter) return fail();
  return discard;
}

/** Reads the owners and allow rules of the MSYS2 paths from PowerShell, or null when it cannot report them. */
function aclProbe(requireShell = false): AclProbe | null {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$paths = @(${MSYS2_CHECKED.map((path) => `'${path}'`).join(', ')})`,
    `$profileDir = '${MSYS2_PROFILE_D}'`,
    'if (Test-Path -LiteralPath $profileDir) { $paths += @(Get-ChildItem -LiteralPath $profileDir -File -Force | ForEach-Object { $_.FullName }) }',
    '$paths = @($paths | Select-Object -Unique)',
    '$objects = @(foreach ($path in $paths) {',
    '  if (-not (Test-Path -LiteralPath $path)) { continue }',
    '  $item = Get-Item -LiteralPath $path -Force',
    '  $isDirectory = $item.PSIsContainer',
    '  $reparse = [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)',
    '  $acl = if ($isDirectory) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }',
    '  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])',
    '  $ownerName = try { $owner.Translate([System.Security.Principal.NTAccount]).Value } catch { $owner.Value }',
    '  $rules = @($acl.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow } | ForEach-Object {',
    '    $sid = if ($_.IdentityReference -is [System.Security.Principal.SecurityIdentifier]) { $_.IdentityReference } else { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) }',
    '    $name = try { $sid.Translate([System.Security.Principal.NTAccount]).Value } catch { $sid.Value }',
    '    [pscustomobject]@{ sid = $sid.Value; name = $name; rights = [int]$_.FileSystemRights }',
    '  })',
    '  [pscustomobject]@{ path = $path; directory = $isDirectory; reparse = $reparse; owner = $owner.Value; ownerName = $ownerName; rules = $rules }',
    '})',
    '$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '[pscustomobject]@{ current = $current; objects = $objects } | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n');
  const result = run([systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000 });
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const decoded = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as { current?: unknown; objects?: RawObject | RawObject[] };
    const objects = (Array.isArray(decoded.objects) ? decoded.objects : decoded.objects ? [decoded.objects] : []).map((object): AclObject => ({
      path: String(object.path ?? ''),
      kind: object.directory === true ? 'directory' : 'file',
      reparse: object.reparse === true,
      owner: String(object.owner ?? ''),
      ownerName: String(object.ownerName ?? object.owner ?? ''),
      rules: (Array.isArray(object.rules) ? object.rules : object.rules ? [object.rules] : []).map((rule) => ({
        sid: String(rule.sid ?? ''),
        name: String(rule.name ?? rule.sid ?? ''),
        rights: Number(rule.rights ?? 0),
      })),
    }));
    const normalized = (path: string) => path.replace(/[\\/]+$/, '').toLowerCase();
    const has = (path: string) => objects.some((object) => normalized(object.path) === normalized(path));
    if (!has(MSYS2_ROOT) || (requireShell && !has(MSYS2_SHELL))) return null;
    return { current: String(decoded.current ?? ''), objects };
  } catch {
    return null;
  }
}

/** A path from the probe as PowerShell wrote it, before the shape is checked. */
type RawObject = { path?: unknown; directory?: unknown; reparse?: unknown; owner?: unknown; ownerName?: unknown; rules?: RawRule | RawRule[] };

/** One rule from the probe as PowerShell wrote it, before the shape is checked. */
type RawRule = { sid?: unknown; name?: unknown; rights?: unknown };

/** Absolute path of a tool in the Windows system folder, so a same-named file in the working directory cannot stand in for it. */
function systemTool(...parts: string[]): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...parts);
}

/** Absolute path of winget, or null when LOCALAPPDATA is not set. */
export function wingetPath(): string | null {
  return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe') : null;
}

/** The Windows session id of this process, or null when PowerShell cannot report it. */
export function windowsSessionId(): number | null {
  const result = run([systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', '[System.Diagnostics.Process]::GetCurrentProcess().SessionId'], { timeout: 15000 });
  const text = result.stdout?.trim() ?? '';
  return result.status === 0 && /^\d+$/.test(text) ? Number(text) : null;
}

/** The creation time of a Windows process as a FILETIME string, or null when it cannot be read. */
export function windowsStartTime(pid: number): string | null {
  const result = run([systemTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], { timeout: 15000 });
  const text = result.stdout?.trim() ?? '';
  return result.status === 0 && /^\d+$/.test(text) ? text : null;
}

/** Ends a process and every process it started. A failure is ignored because the process may already be gone. */
export function killTree(pid: number): void {
  run([systemTool('taskkill.exe'), '/PID', String(pid), '/T', '/F'], { timeout: 10000 });
}
