#!/usr/bin/env node
/**
 * remote-pi-daemon — 跨平台部署 / 运维工具
 *
 * 把官方 remote-pi 的「常驻 daemon」这一层（pi-supervisord + N 个 pi --mode rpc）
 * 用一条命令装好、验好、管起来。Windows / macOS / Linux 同一套入口。
 *
 * 设计原则：
 *   1. 只用官方 CLI（remote-pi install / create / daemon ...），不复制官方逻辑，
 *      不手搓任务计划 / plist / systemd unit。
 *   2. 幂等：重复执行只会修复，不会重复注册。
 *   3. 不碰 `~/.pi/agent/settings.json` 的 packages —— 0.7.0 已内置双加载去重。
 *   4. 永不调用全量 `daemon start`（0.7.0 的 _opStartAll 会丢 name），
 *      一律走 create（内部 _opStart 带 name）或 `daemon restart <id>`。
 *
 * 依赖：node >= 20（pi 本身要求）+ 已安装 pi + npm。
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync,
  readdirSync, statSync, renameSync, copyFileSync, unlinkSync,
} from 'node:fs';
import { homedir, platform, release, userInfo, tmpdir } from 'node:os';
import { join, resolve, basename, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const IS_LINUX = platform() === 'linux';
const HOME = homedir();
const PI_DIR = join(HOME, '.pi');
const REMOTE_DIR = join(PI_DIR, 'remote');
const AGENT_SETTINGS = join(PI_DIR, 'agent', 'settings.json');
const SUPERVISOR_TASK = 'RemotePiSupervisor';
const LAUNCHD_LABEL = 'dev.remotepi.supervisord';
const SYSTEMD_UNIT = 'remote-pi-supervisord.service';
const LOG_FILE = join(REMOTE_DIR, 'supervisord.log');

/** daemon 的默认工作目录：~/workspace/repo/daemon */
function defaultCwd() {
  return join(HOME, 'workspace', 'repo', 'daemon');
}

// ── 终端输出 ────────────────────────────────────────────────────────────────
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const blue = c('36');

let STEP = 0;
const ok = (m) => console.log(`${green('✓')} ${m}`);
const warn = (m) => console.log(`${yellow('!')} ${m}`);
const fail = (m) => console.log(`${red('✗')} ${m}`);
const info = (m) => console.log(`${blue('·')} ${m}`);
const step = (m) => console.log(`\n${bold(`[${++STEP}] ${m}`)}`);
const indent = (s) => String(s).split('\n').map((l) => `    ${dim(l)}`).join('\n');

class DeployError extends Error {}

// ── 基础工具 ────────────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  // Windows 上 npm / schtasks 这类是 .cmd / .exe 包装，直接 spawn 一个不带扩展名的
  // 名字会 ENOENT；显式带上 shell 让 cmd.exe 解析（参数均由本工具生成，无外部输入）。
  const needsShell = opts.shell ?? (IS_WIN && /\.(cmd|bat)$/i.test(cmd));
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 180_000,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    windowsHide: true,
    shell: needsShell,
  });
  return {
    code: res.status ?? -1,
    signal: res.signal ?? null,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    error: res.error ?? null,
  };
}

function mustRun(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  if (r.error) throw new DeployError(`${cmd} 无法执行: ${r.error.message}`);
  if (r.code !== 0) {
    const detail = [r.stderr, r.stdout].filter(Boolean).join('\n');
    throw new DeployError(`${cmd} ${args.join(' ')} 失败 (exit ${r.code})\n${detail}`);
  }
  return r;
}

const nodeBin = process.execPath;
const npmBin = IS_WIN ? 'npm.cmd' : 'npm';

function which(name) {
  const r = IS_WIN
    ? run('where', [name])
    : run('sh', ['-lc', `command -v ${name}`]);
  if (r.code !== 0) return null;
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

function realpathOr(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

function readJson(p, fallback = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function daemonIdForCwd(cwd) {
  return createHash('sha256').update(realpathOr(cwd)).digest('hex').slice(0, 8);
}

/** pi 的会话目录命名：`--C--Users-jiang-workspace--` */
function sessionDirFor(cwd) {
  const mangled = realpathOr(cwd).replace(/[:\\/]/g, '-');
  return join(PI_DIR, 'agent', 'sessions', `--${mangled}--`);
}

function fmtBytes(n) {
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function dirSize(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  for (const name of readdirSync(p)) {
    const f = join(p, name);
    try {
      const st = statSync(f);
      total += st.isDirectory() ? dirSize(f) : st.size;
    } catch { /* 忽略消失的文件 */ }
  }
  return total;
}

function tail(p, lines = 20) {
  if (!existsSync(p)) return '';
  const content = readFileSync(p, 'utf8');
  return content.split(/\r?\n/).slice(-lines).join('\n');
}

// ── remote-pi CLI 定位 ──────────────────────────────────────────────────────
/** 用 `npm root -g` 定位全局包，直接 `node <cli>`，绕开 PATH / .cmd shim 差异。 */
function globalPackageDir() {
  const r = run(npmBin, ['root', '-g'], { timeout: 60_000 });
  if (r.code !== 0) return null;
  const root = r.stdout.split(/\r?\n/).pop()?.trim();
  if (!root) return null;
  return join(root, 'remote-pi');
}

function globalCliPath() {
  const dir = globalPackageDir();
  if (!dir) return null;
  const cli = join(dir, 'dist', 'index.js');
  return existsSync(cli) ? cli : null;
}

function globalVersion() {
  const dir = globalPackageDir();
  if (!dir) return null;
  return readJson(join(dir, 'package.json'))?.version ?? null;
}

/** 调官方 CLI：`node <cli> <args...>` */
function cli(args, opts = {}) {
  const cliPath = globalCliPath();
  if (!cliPath) {
    throw new DeployError('找不到全局 remote-pi。先执行：npm install -g remote-pi（或去掉 --skip-global）');
  }
  return run(nodeBin, [cliPath, ...args], opts);
}

function cliMust(args, opts = {}) {
  const r = cli(args, opts);
  if (r.code !== 0) {
    const detail = [r.stderr, r.stdout].filter(Boolean).join('\n');
    throw new DeployError(`remote-pi ${args.join(' ')} 失败 (exit ${r.code})\n${detail}`);
  }
  return r;
}

const BS = String.fromCharCode(92);   // 反斜杠，避开模板/JSON 转义

/**
 * supervisor 的控制通道：
 *   POSIX  → ~/.pi/remote/supervisor.sock（真实文件）
 *   Windows → \.\pipe
emote-pi-supervisor-<user>（命名管道，没有文件实体）
 * 命名规则来自包内 dist/session/ipc.js 的 ipcAddress("supervisor", ...)。
 */
function supervisorSocketPath() {
  if (IS_WIN) {
    const u = (userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
    return `${BS}${BS}.${BS}pipe${BS}remote-pi-supervisor-${u}`;
  }
  const root = process.env.REMOTE_PI_HOME || HOME;
  return join(root, '.pi', 'remote', 'supervisor.sock');
}

function supervisorAlive() {
  const path = supervisorSocketPath();
  if (!IS_WIN) return existsSync(path);
  // Windows 管道没有文件可 stat，用一次连接试探（放在子进程里做，同步流程不受影响）
  const probe = `
    const net = require('net');
    const s = net.createConnection(process.argv[1]);
    s.on('connect', () => { process.stdout.write('up'); s.destroy(); process.exit(0); });
    s.on('error', () => { process.stdout.write('down'); process.exit(0); });
    setTimeout(() => { process.stdout.write('down'); process.exit(0); }, 800);
  `;
  const r = run(nodeBin, ['-e', probe, path], { timeout: 5_000 });
  return (r.stdout || '').trim() === 'up';
}

// ── 预检 ────────────────────────────────────────────────────────────────────
function preflight() {
  step('预检环境');
  const problems = [];

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) problems.push(`node ${process.versions.node} 太旧（需要 >= 20）`);
  else ok(`node ${process.versions.node} (${platform()} ${release()})`);

  const piBin = which('pi');
  if (!piBin) problems.push('PATH 里找不到 `pi` —— supervisor 服务会继承当前 PATH，装完也起不来');
  else ok(`pi → ${piBin}`);

  const npmv = run(npmBin, ['--version'], { timeout: 60_000 });
  if (npmv.code !== 0) problems.push('找不到 npm');
  else ok(`npm ${npmv.stdout}`);

  if (!IS_WIN && !IS_MAC && !IS_LINUX) problems.push(`不支持的平台：${platform()}`);

  if (problems.length) {
    for (const p of problems) fail(p);
    throw new DeployError('预检未通过，已中止（未做任何修改）');
  }
}

// ── 全局包 ──────────────────────────────────────────────────────────────────
function ensureGlobalPackage({ skip = false, dryRun = false } = {}) {
  step('全局包 remote-pi');
  const current = globalVersion();
  if (current) {
    ok(`已安装 remote-pi@${current} → ${globalCliPath()}`);
    return current;
  }
  if (skip) {
    throw new DeployError('全局包未安装，且指定了 --skip-global。先执行 npm install -g remote-pi');
  }
  info('未检测到全局 remote-pi，安装中（官方要求 CLI 来自 npm 全局，pi install 只装扩展）…');
  if (dryRun) {
    info('[dry-run] npm install -g remote-pi');
    return '(dry-run)';
  }
  const r = run(npmBin, ['install', '-g', 'remote-pi'], { timeout: 600_000 });
  if (r.code !== 0) throw new DeployError(`npm install -g remote-pi 失败\n${r.stderr || r.stdout}`);
  const v = globalVersion();
  if (!v) throw new DeployError('安装后仍找不到全局 remote-pi，检查 npm 全局前缀');
  ok(`remote-pi@${v}`);
  return v;
}

// ── relay ───────────────────────────────────────────────────────────────────
function setRelay(url, { dryRun = false } = {}) {
  step(`relay 地址`);
  if (!/^https?:\/\//.test(url)) throw new DeployError(`relay 必须以 http:// 或 https:// 开头：${url}`);
  const cfgPath = join(REMOTE_DIR, 'config.json');
  const before = readJson(cfgPath, {}) ?? {};
  if (before.relay === url) {
    ok(`已是 ${url}`);
    return;
  }
  if (dryRun) {
    info(`[dry-run] remote-pi set-relay ${url}`);
    return;
  }
  cliMust(['set-relay', url], { timeout: 60_000 });
  ok(`${before.relay ?? '(默认社区 relay)'} → ${url}`);
}

// ── settings.json 对齐 ──────────────────────────────────────────────────────
/**
 * remote-pi 0.7.0 的「双加载去重」（globalThis + WeakSet，keyed by `pi`）在
 * pi 1.5.2 上实测不生效：supervisor 用 `-e <全局包>/dist/index.js` 拉起 daemon，
 * 而 settings.json 的 packages 会再自动发现 `~/.pi/agent/npm/node_modules/remote-pi`，
 * 两个路径不同 → 两份模块实例 → `Tool "agent_send" conflicts` → daemon 崩溃循环。
 *
 * 唯一可靠的办法是让两处 realpath 相同：把 packages 指向当前全局包。
 * 代价是 node 版本/全局前缀变了要重跑 install —— 所以这个工具负责维护它。
 */
function alignSettingsPackages({ dryRun = false } = {}) {
  step('对齐 settings.json 的 packages');
  const dir = globalPackageDir();
  if (!dir) {
    warn('找不到全局包，跳过');
    return;
  }
  const target = realpathOr(dir).split(sep).join('/');
  const settings = readJson(AGENT_SETTINGS, null);
  if (!settings) {
    warn(`读不到 ${AGENT_SETTINGS}，跳过`);
    return;
  }
  const pkgs = Array.isArray(settings.packages) ? settings.packages.slice() : [];
  const idx = pkgs.findIndex((p) => typeof p === 'string' && /remote-pi/i.test(p));

  if (idx >= 0) {
    if (pkgs[idx] === target) { ok(`已对齐 ${target}`); return; }
    info(`当前：${pkgs[idx]}`);
    if (dryRun) { info(`[dry-run] → ${target}`); return; }
    pkgs[idx] = target;
  } else {
    if (dryRun) { info(`[dry-run] packages += ${target}`); return; }
    pkgs.push(target);
  }

  settings.packages = pkgs;
  writeJson(AGENT_SETTINGS, settings);
  ok(`packages → ${target}`);
  info('理由：daemon 的 -e 与自动发现的扩展必须是同一个 realpath，否则工具名冲突');
}

/** 检查 packages 与全局包是否指向同一 realpath（doctor 用）。 */
function packagesAligned() {
  const dir = globalPackageDir();
  if (!dir) return { ok: false, reason: '没有全局包' };
  const target = realpathOr(dir);
  const pkgs = readJson(AGENT_SETTINGS, {})?.packages;
  if (!Array.isArray(pkgs)) return { ok: false, reason: 'settings.json 里没有 packages' };
  const entry = pkgs.find((p) => typeof p === 'string' && /remote-pi/i.test(p));
  if (!entry) return { ok: false, reason: 'packages 里没有 remote-pi' };
  if (/^npm:/i.test(entry)) return { ok: false, reason: `仍是 ${entry}（会解析到另一个副本）` };
  const same = realpathOr(entry) === target;
  return same ? { ok: true } : { ok: false, reason: `${entry} ≠ ${target}` };
}

// ── 服务安装 ────────────────────────────────────────────────────────────────
function installService({ dryRun = false } = {}) {
  step('安装 supervisor 系统服务');
  if (IS_WIN) info('Windows 会弹出一次 UAC（schtasks 写根任务库需要管理员），请点「是」');
  else if (IS_MAC) info('macOS 写 ~/Library/LaunchAgents 并 launchctl bootstrap（不需要 sudo）');
  else info('Linux 写 systemd --user unit 并 enable --now');

  if (dryRun) {
    info('[dry-run] remote-pi install');
    return;
  }

  const r = cli(['install'], { timeout: 300_000 });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
  if (r.code !== 0) {
    if (/拒绝访问|Access is denied|elevation|UAC|The operation was canceled/i.test(output)) {
      throw new DeployError(`服务安装失败：UAC 被拒绝或权限不足。\n${output}`);
    }
    throw new DeployError(`remote-pi install 失败 (exit ${r.code})\n${output}`);
  }
  if (output) console.log(indent(output));

  // 给 supervisor 一点时间把 UDS 建起来
  for (let i = 0; i < 8; i++) {
    if (supervisorAlive()) break;
    run(nodeBin, ['-e', 'setTimeout(()=>{},250)'], { timeout: 5_000 });
  }
  if (supervisorAlive()) ok(`supervisor 已就绪 (${supervisorSocketPath()})`);
  else warn('supervisor UDS 尚未出现，稍后用 `status` 复查；日志见 ~/.pi/remote/supervisord.log');
}

// ── Windows 崩溃自愈加固 ────────────────────────────────────────────────────
/**
 * 官方任务模板只有 `<RestartOnFailure>`（Settings 下），但它的动作是
 * `wscript.exe → cmd /c → node` 三层包装。实测：supervisor 被外部终止后，
 * 任务停在 Ready / LastTaskResult=1，RestartOnFailure 从不触发。
 *
 * 加固办法是给 LogonTrigger 加 `<Repetition>`：任务计划每 N 分钟重触发一次，
 * 配合 `MultipleInstancesPolicy=IgnoreNew`，已在运行时直接跳过；崩溃后则会在
 * 下一次重复间隔被拉起。这是 Windows 上唯一稳定的看门狗手段。
 */
const HARDEN_INTERVAL = 'PT2M';

/**
 * 用提权的 cmd 跑 schtasks 序列（一次 UAC），输出重定向到临时文件再读回。
 * 与官方 install.js 的 _execElevatedWindows 同思路：父进程无法自我提权。
 */
/**
 * 官方启动器只跑一次 node 就退出，退出码交给 Task Scheduler。
 * 实测在 Win10 22H2 上 `RestartOnFailure` 和 trigger 的 `Repetition` 都不触发
 * （LastTaskResult=1 / State=Ready，等 150s 无任何重启），supervisor 一崩就永久离线。
 *
 * 加固做法：把它换成「保活包壳」—— wscript 常驻，node 退出后 5 秒重跑。
 * 这样绝大多数崩溃（未捕获异常、OOM、子进程被杀）都能秒级自愈，不再依赖
 * Task Scheduler 的重启语义。原始文件按 `.official-<ts>` 备份。
 */
function armorLauncher({ dryRun = false } = {}) {
  const vbsPath = join(REMOTE_DIR, 'RemotePiSupervisorLauncher.vbs');
  if (!existsSync(vbsPath)) {
    warn(`找不到 ${vbsPath}，先跑 install`);
    return false;
  }

  const vbs = readFileSync(vbsPath, 'utf8');
  if (/^\s*Do\s*$/m.test(vbs) && /WScript\.Sleep/i.test(vbs)) {
    ok('启动器已是保活版');
    return true;
  }

  const m = vbs.match(/\.Run\((".*?"), 0, True\)/s);
  if (!m) {
    warn('无法从现有启动器里提取启动命令，跳过加固');
    return false;
  }
  const cmdLiteral = m[1];

  const armored = [
    "' Remote Pi supervisor launcher — armored (auto-restart wrapper).",
    "' Generated by remote-pi-daemon. The official template runs node once and exits;",
    "' this wrapper keeps wscript alive and re-runs node 5s after any exit, so a",
    "' supervisor crash self-heals without relying on Task Scheduler restart semantics.",
    'Dim rc',
    'Do',
    `  rc = CreateObject("Wscript.Shell").Run(${cmdLiteral}, 0, True)`,
    '  WScript.Sleep 5000',
    'Loop',
    '',
  ].join(String.fromCharCode(13, 10));

  if (dryRun) {
    info('[dry-run] 把启动器换成保活版并重启任务');
    return true;
  }

  const backup = `${vbsPath}.official-${Date.now()}`;
  copyFileSync(vbsPath, backup);
  writeFileSync(vbsPath, armored, 'utf8');
  ok(`启动器已换成保活版（原文件备份 ${basename(backup)}）`);
  return true;
}

/** 杀掉当前任务实例并重新启动（让新的保活启动器生效）。 */
function restartScheduledTask() {
  const r = run('powershell', [
    '-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'wscript.exe' -and $_.CommandLine -match 'RemotePiSupervisorLauncher' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }; ` +
      `Start-ScheduledTask -TaskName '${SUPERVISOR_TASK}'; 'restarted'`,
  ], { timeout: 60_000 });
  return r.code === 0;
}

function registeredTaskHardened() {
  const r = run('powershell', [
    '-NoProfile', '-Command',
    `(Export-ScheduledTask -TaskName '${SUPERVISOR_TASK}') -match 'Repetition'`,
  ], { timeout: 30_000 });
  return /True/i.test(r.stdout);
}

function elevatedSchTasks(xmlPath) {
  const base = join(tmpdir(), `remote-pi-task-${process.pid}`);
  const cmdPath = `${base}.cmd`;
  const logFile = `${base}.log`;
  const lines = [
    '@echo off',
    `schtasks /Create /XML "${xmlPath}" /TN ${SUPERVISOR_TASK} /F >> "${logFile}" 2>&1`,
    `schtasks /End /TN ${SUPERVISOR_TASK} >> "${logFile}" 2>&1`,
    `schtasks /Run /TN ${SUPERVISOR_TASK} >> "${logFile}" 2>&1`,
  ].join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10);
  writeFileSync(cmdPath, lines, 'utf8');
  try { unlinkSync(logFile); } catch { /* 本来就没有 */ }

  const r = run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$p = Start-Process -FilePath cmd.exe -ArgumentList '/c','"${cmdPath}"' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`,
  ], { timeout: 180_000 });

  let log = '';
  try { log = readFileSync(logFile, 'utf8').trim(); } catch { /* 无日志 */ }
  const failed = /ERROR|错误|denied|拒绝/i.test(log);
  return { ok: r.code === 0 && !failed, log: log || r.stderr || '(无输出)' };
}

function hardenWindowsService({ dryRun = false } = {}) {
  step('加固：崩溃自愈');
  if (!IS_WIN) {
    ok(`${IS_MAC ? 'launchd KeepAlive' : 'systemd Restart=on-failure'} 自带崩溃重启，无需加固`);
    return;
  }

  // 主手段：保活启动器（wscript 常驻，node 退出 5s 后重跑）。
  // 它不依赖 Task Scheduler，实测比 RestartOnFailure / Repetition 可靠得多。
  const armored = armorLauncher({ dryRun });

  // 次要手段：trigger 上的 Repetition（保活包壳本身被杀时，任务计划还有机会拉回）
  const xmlPath = join(REMOTE_DIR, 'RemotePiSupervisor.xml');
  if (existsSync(xmlPath)) {
    const xmlHasRepetition = /<Repetition>/.test(readFileSync(xmlPath, 'utf16le'));
    const taskHasRepetition = registeredTaskHardened();

    if (xmlHasRepetition && taskHasRepetition) {
      ok('Repetition 已生效');
    } else if (dryRun) {
      info(`[dry-run] Repetition ${HARDEN_INTERVAL} 尚未生效，会提权重新注册任务`);
    } else {
      let shouldRegister = false;
      if (!xmlHasRepetition) {
        const xml = readFileSync(xmlPath, 'utf16le');
        const patched = xml.replace(
          /(<LogonTrigger>\s*<Enabled>true<\/Enabled>)/,
          `$1
      <Repetition>
        <Interval>${HARDEN_INTERVAL}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>`,
        );
        if (patched === xml) {
          warn('没找到 LogonTrigger 结构，跳过 Repetition');
        } else {
          const backup = `${xmlPath}.bak-${Date.now()}`;
          copyFileSync(xmlPath, backup);
          writeFileSync(xmlPath, patched, 'utf16le');
          ok(`已写入 Repetition ${HARDEN_INTERVAL}（备份 ${basename(backup)}）`);
          shouldRegister = true;
        }
      } else {
        shouldRegister = true;
      }

      if (shouldRegister) {
        info('重新注册任务需要一次 UAC');
        const result = elevatedSchTasks(xmlPath);
        if (!result.ok) {
          warn(`Repetition 注册失败（保活启动器仍然有效）
${result.log}`);
        } else {
          console.log(indent(result.log));
          ok('Repetition 已激活');
        }
      }
    }
  }

  if (armored && !dryRun) {
    info('重启任务让保活启动器生效');
    if (restartScheduledTask()) ok('任务已重启');
    else warn('任务重启失败，手动执行：Start-ScheduledTask -TaskName RemotePiSupervisor');
  }
}

// ── daemon 注册 ─────────────────────────────────────────────────────────────
function createDaemon(cwd, name, { dryRun = false, noStart = false } = {}) {
  step(`注册 daemon：${cwd}`);
  const id = daemonIdForCwd(cwd);

  // daemon 用 --continue 续「该 cwd 最新的会话文件」，而 pi 没有会话锁。
  // 如果此刻同一个 cwd 里还开着交互式 pi，两个进程会往同一个 jsonl 追加。
  // 交互式会话刚被写过 → 大概率正在使用；提示 + 允许 --no-start 规避。
  const recent = recentlyActiveSession(cwd);
  if (recent) {
    warn(`该目录的会话 ${recent.name} 在 ${Math.round(recent.ageSec)} 秒前刚被写过。`);
    info('若此刻有交互式 pi 开着同一目录，daemon 的 --continue 会续到同一个会话文件。');
    info('建议先关掉那个 pi 窗口再启动 daemon（本工具提供的 --no-start 就是为此）。');
  }
  if (dryRun) {
    info(`[dry-run] remote-pi create "${cwd}" --name "${name}"  → id=${id}`);
    return { id, created: false };
  }

  const list = cli(['daemons'], { timeout: 60_000 });
  const alreadyRegistered = new RegExp(`\\b${id}\\b`).test(list.stdout);

  if (alreadyRegistered) {
    ok(`已注册（id=${id}），跳过 create`);
  } else {
    const r = cli(['create', cwd, '--name', name], { timeout: 120_000 });
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n');
    if (out) console.log(indent(out));
    if (r.code !== 0) throw new DeployError(`注册 daemon 失败\n${out}`);
    ok(`已注册并启动（id=${id}）`);
  }

  // 关键：用单 id 的 restart 确保 registry 里的 name 被注入
  // （全量 `daemon start` 在 0.7.0 会丢 name：_opStartAll 未传 entry.name）
  if (noStart) {
    const sr = cli(['daemon', 'stop', id], { timeout: 120_000 });
    if (sr.code === 0) {
      ok('已注册，但按 --no-start 停住');
      info('关掉同目录的交互式 pi 后执行：node deploy.mjs restart');
    } else {
      warn(`停止返回非 0：${sr.stderr || sr.stdout}`);
    }
    return { id, created: !alreadyRegistered };
  }

  const rr = cli(['daemon', 'restart', id], { timeout: 120_000 });
  if (rr.code === 0) ok(`已用 registry 名字重启：${name}`);
  else warn(`重启返回非 0：${rr.stderr || rr.stdout}`);

  return { id, created: !alreadyRegistered };
}

// ── 验证 ────────────────────────────────────────────────────────────────────
function verify({ id, dryRun = false } = {}) {
  step('验证');
  if (dryRun) {
    info('[dry-run] 跳过验证');
    return true;
  }
  let good = true;

  const list = cli(['daemons'], { timeout: 60_000 });
  console.log(indent(list.stdout || '(空)'));
  if (id && !new RegExp(`\\b${id}\\b`).test(list.stdout)) {
    fail(`registry 里看不到 id=${id}`);
    good = false;
  } else if (id) {
    ok('registry 可见');
  }

  const status = cli(['daemon', 'status'], { timeout: 60_000 });
  console.log(indent(status.stdout || '(空)'));

  if (/crashed|stopped/i.test(status.stdout)) {
    fail('有 daemon 处于 crashed/stopped —— 常见原因见 README「排障」');
    good = false;
  } else if (/running/i.test(status.stdout)) {
    ok('daemon 运行中');
  }

  const logTail = tail(LOG_FILE, 60);
  const badPatterns = [
    [/Tool "(\w+)" conflicts|duplicate/i, '扩展被加载两次 / 工具名冲突'],
    [/Cannot find module/i, '依赖缺失（PATH 或 node_modules）'],
    [/pi: command not found|ENOENT.*pi\b/i, 'supervisor 找不到 pi 可执行文件'],
    [/RoomAlreadyOpenError/i, 'relay 房间里已有同名连接'],
  ];
  for (const [re, why] of badPatterns) {
    if (re.test(logTail)) {
      fail(`日志命中：${why}`);
      good = false;
    }
  }

  if (good) ok('全部通过');
  return good;
}

// ── 会话体积体检（之前 61s 卡顿的根因）──────────────────────────────────────
/** 找该 cwd 最新的会话文件，判断是不是刚被写过（可能正有交互式 pi 在跑）。 */
function recentlyActiveSession(cwd, thresholdSec = 600) {
  const dir = sessionDirFor(cwd);
  if (!existsSync(dir)) return null;
  let newest = null;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    const full = join(dir, f);
    try {
      const st = statSync(full);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { name: f, mtimeMs: st.mtimeMs };
    } catch { /* 忽略 */ }
  }
  if (!newest) return null;
  const ageSec = (Date.now() - newest.mtimeMs) / 1000;
  return ageSec <= thresholdSec ? { name: newest.name, ageSec } : null;
}

function sessionHealth(cwd) {
  const dir = sessionDirFor(cwd);
  if (!existsSync(dir)) return { dir, files: 0, bytes: 0, largest: null };
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  let bytes = 0;
  let largest = null;
  for (const f of files) {
    const size = statSync(join(dir, f)).size;
    bytes += size;
    if (!largest || size > largest.size) largest = { name: f, size };
  }
  return { dir, files: files.length, bytes, largest };
}

function resetSession(cwd, { archive = true } = {}) {
  const dir = sessionDirFor(cwd);
  if (!existsSync(dir)) return { moved: 0 };
  const archiveDir = join(dir, '.archive');
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  if (!files.length) return { moved: 0 };
  if (archive) mkdirSync(archiveDir, { recursive: true });
  let moved = 0;
  for (const f of files) {
    const src = join(dir, f);
    const dst = join(archiveDir, `${Date.now()}-${f}`);
    if (archive) { copyFileSync(src, dst); renameSync(src, dst); }
    else { renameSync(src, join(dir, `${f}.bak-${Date.now()}`)); }
    moved++;
  }
  return { moved, archiveDir: archive ? archiveDir : null };
}

// ── 旧部署残留检测 ──────────────────────────────────────────────────────────
function detectLegacy() {
  const findings = [];

  // 1) 手工部署留下的排查 / 补丁脚本。
  // 注意：RemotePiSupervisor.xml 与 RemotePiSupervisorLauncher.vbs 是官方
  // `remote-pi install` 在 Windows 上的正常产物，不能算残留。
  for (const f of [
    'boot-check.ps1', 'boot-check.vbs', 'boot-check.log', 'boot-check-baseline.txt',
    'fix-remote-pi-zombie-ws.mjs', 'README-parrot-daemon.md',
  ]) {
    if (existsSync(join(REMOTE_DIR, f))) findings.push(join(REMOTE_DIR, f));
  }
  for (const f of readdirSync(REMOTE_DIR).filter((n) => /Launcher\.vbs\.bak/.test(n))) {
    findings.push(join(REMOTE_DIR, f));
  }

  // 2) 启动文件夹里的手搓保活脚本
  if (IS_WIN) {
    const startup = join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    if (existsSync(startup)) {
      for (const f of readdirSync(startup)) {
        if (/remote-pi|pi-supervisor|pi-relay/i.test(f)) findings.push(join(startup, f));
      }
    }
  }

  // 3) settings.json 的 packages 与全局包是否一致
  // （绝对路径本身是必需的，见 alignSettingsPackages；不一致由 doctor 检查）

  return findings;
}

function cleanLegacy({ dryRun = false } = {}) {
  const findings = detectLegacy();
  if (!findings.length) { ok('没有旧部署残留'); return; }
  for (const f of findings) {
    if (f.includes('settings.json')) {
      warn(`需手工改：${f}  → 改成 "npm:remote-pi"`);
      continue;
    }
    if (dryRun) { info(`[dry-run] 删除 ${f}`); continue; }
    try {
      spawnSync(IS_WIN ? 'cmd' : 'rm', IS_WIN ? ['/c', 'del', '/f', '/q', f] : ['-f', f], { windowsHide: true });
      ok(`已删除 ${f}`);
    } catch { warn(`删除失败：${f}`); }
  }
}

// ── 服务状态 ────────────────────────────────────────────────────────────────
function serviceState() {
  if (IS_WIN) {
    const q = run('schtasks', ['/Query', '/TN', SUPERVISOR_TASK, '/FO', 'LIST'], { timeout: 30_000 });
    if (q.code !== 0) return { installed: false, state: 'not-installed' };
    const m = q.stdout.match(/Status:\s*(\S+)/i) ?? q.stdout.match(/状态:\s*(\S+)/);
    return { installed: true, state: (m?.[1] ?? 'unknown').toLowerCase() };
  }
  if (IS_MAC) {
    const q = run('launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { timeout: 30_000 });
    if (q.code !== 0) return { installed: false, state: 'not-installed' };
    return { installed: true, state: 'loaded' };
  }
  const q = run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], { timeout: 30_000 });
  return { installed: q.code === 0 || /inactive|failed/.test(q.stdout), state: q.stdout || 'unknown' };
}

// ── 子命令 ──────────────────────────────────────────────────────────────────
function cmdInstall(opts) {
  const cwd = resolve(opts.cwd ?? defaultCwd());
  if (!existsSync(cwd)) {
    step('准备默认工作目录');
    if (opts.dryRun) info(`[dry-run] mkdir -p ${cwd}`);
    else { mkdirSync(cwd, { recursive: true }); ok(`已创建 ${cwd}`); }
  }
  const name = opts.name ?? basename(cwd);

  preflight();

  step('旧部署残留');
  const legacy = detectLegacy();
  if (legacy.length) {
    for (const f of legacy) warn(f);
    info('这些是手工部署产物，官方方案不需要。用 `doctor --clean` 清理。');
  } else {
    ok('无');
  }

  ensureGlobalPackage({ skip: opts.skipGlobal, dryRun: opts.dryRun });
  alignSettingsPackages({ dryRun: opts.dryRun });
  if (opts.relay) setRelay(opts.relay, { dryRun: opts.dryRun });
  installService({ dryRun: opts.dryRun });
  if (!opts.noHarden) hardenWindowsService({ dryRun: opts.dryRun });
  const { id } = createDaemon(cwd, name, { dryRun: opts.dryRun, noStart: opts.noStart });
  const good = verify({ id, dryRun: opts.dryRun });

  step('完成');
  console.log(`  cwd      ${bold(cwd)}`);
  console.log(`  name     ${bold(name)}`);
  console.log(`  id       ${bold(id)}`);
  console.log(`  relay    ${bold(readJson(join(REMOTE_DIR, 'config.json'), {})?.relay ?? '(默认社区 relay)')}`);
  console.log(`  service  ${bold(serviceState().state)}`);
  console.log('');
  console.log(bold('  下一步：手机配对（只需一次）'));
  console.log(`    1) cd "${cwd}" && pi`);
  console.log('    2) 在 pi 里执行  /remote-pi pair   然后手机扫码');
  console.log('    3) 关掉这个 pi 窗口，daemon 接管后台');
  console.log('');
  if (!good) {
    console.log(yellow('  验证未全部通过，看 `node deploy.mjs doctor` 的结论。'));
    return 1;
  }
  return 0;
}

function cmdStatus(opts) {
  const cwd = resolve(opts.cwd ?? defaultCwd());
  console.log(bold('\nremote-pi daemon 状态'));
  console.log(`  平台      ${platform()} ${release()}`);
  console.log(`  node      ${process.versions.node}`);
  const gv = globalVersion();
  console.log(`  全局包    ${gv ? `remote-pi@${gv}` : red('未安装')}`);
  const svc = serviceState();
  console.log(`  service   ${svc.installed ? green(svc.state) : red('未安装')}`);
  console.log(`  UDS       ${supervisorAlive() ? green(supervisorSocketPath()) : dim('不存在')}`);

  const cfg = readJson(join(REMOTE_DIR, 'config.json'), {}) ?? {};
  console.log(`  relay     ${cfg.relay ?? dim('(默认社区 relay)')}`);

  if (gv) {
    console.log(bold('\n  registry'));
    const list = cli(['daemons'], { timeout: 60_000 });
    console.log(indent(list.stdout || '(空)'));

    const st = cli(['daemon', 'status'], { timeout: 60_000 });
    console.log(bold('\n  运行态'));
    console.log(indent(st.stdout || '(空)'));
  }

  const health = sessionHealth(cwd);
  console.log(bold(`\n  会话体检 (${cwd})`));
  console.log(`  目录      ${health.dir}`);
  console.log(`  文件      ${health.files} 个 / ${fmtBytes(health.bytes)}`);
  if (health.largest) {
    const big = health.largest.size > 20 * 1024 ** 2;
    const line = `  最大      ${health.largest.name}  ${fmtBytes(health.largest.size)}`;
    console.log(big ? yellow(line) : line);
    if (big) {
      warn('--continue 的会话已经很大，每轮都要重发全部历史 → 手机上会明显变慢。');
      info('重置：node deploy.mjs reset-session   （归档旧会话，daemon 下轮开新的）');
    }
  }
  return 0;
}

function cmdLogs(opts) {
  if (IS_LINUX) {
    const args = ['--user', '-u', SYSTEMD_UNIT, '-n', String(opts.tail ?? 60)];
    if (opts.follow) args.push('-f');
    const r = run('journalctl', args, { timeout: opts.follow ? 0 : 60_000 });
    console.log(r.stdout || r.stderr);
    return 0;
  }
  if (!existsSync(LOG_FILE)) {
    warn(`日志不存在：${LOG_FILE}`);
    return 1;
  }
  if (opts.follow) {
    const r = run(IS_WIN ? 'powershell' : 'tail', IS_WIN
      ? ['-NoProfile', '-Command', `Get-Content -Path "${LOG_FILE}" -Tail 40 -Wait`]
      : ['-n', '40', '-f', LOG_FILE], { timeout: 0 });
    if (r.error?.code === 'ETIMEDOUT') return 0;
    console.log(r.stdout);
    return 0;
  }
  console.log(tail(LOG_FILE, opts.tail ?? 60));
  return 0;
}

function cmdRestart(opts) {
  const cwd = resolve(opts.cwd ?? defaultCwd());
  const id = daemonIdForCwd(cwd);
  step(`重启 daemon ${id}`);
  const r = cli(['daemon', 'restart', id], { timeout: 120_000 });
  console.log(indent([r.stdout, r.stderr].filter(Boolean).join('\n') || '(无输出)'));
  if (r.code !== 0) return 1;
  ok('已重启');
  return 0;
}

function cmdStop(opts) {
  const cwd = resolve(opts.cwd ?? defaultCwd());
  const id = daemonIdForCwd(cwd);
  step(`停止 daemon ${id}`);
  const r = cli(['daemon', 'stop', id], { timeout: 120_000 });
  console.log(indent([r.stdout, r.stderr].filter(Boolean).join('\n') || '(无输出)'));
  return r.code === 0 ? 0 : 1;
}

function cmdUninstall(opts) {
  const cwd = resolve(opts.cwd ?? defaultCwd());
  const id = daemonIdForCwd(cwd);

  if (opts.removeDaemon) {
    step(`注销 daemon ${id}`);
    const r = cli(['remove', id], { timeout: 60_000 });
    console.log(indent([r.stdout, r.stderr].filter(Boolean).join('\n') || '(无输出)'));
  }

  step('卸载 supervisor 服务');
  if (IS_WIN) info('Windows 会弹一次 UAC');
  const r = cli(['uninstall'], { timeout: 300_000 });
  console.log(indent([r.stdout, r.stderr].filter(Boolean).join('\n') || '(无输出)'));
  if (r.code !== 0) warn('服务卸载返回非 0，可能本来就没装');

  if (opts.purge) {
    step('清除 ~/.pi/remote（配对信息会一起丢失！）');
    if (!opts.yes) {
      warn(`这会把 ${REMOTE_DIR} 整个删掉，包括 peers.json 里的手机配对。`);
      info('确认请加 --yes');
      return 1;
    }
    const backup = `${REMOTE_DIR}.bak-${Date.now()}`;
    renameSync(REMOTE_DIR, backup);
    ok(`已移到 ${backup}（想彻底删就 rm -rf 它）`);
  }

  ok('卸载完成');
  return 0;
}

function cmdDoctor(opts) {
  console.log(bold('\nremote-pi daemon doctor'));
  let issues = 0;
  const check = (label, fn) => {
    try {
      const r = fn();
      if (r === true) ok(label);
      else if (r === false) { fail(label); issues++; }
      else { info(label); }
    } catch (e) {
      fail(`${label} — ${e.message}`); issues++;
    }
  };

  check(`node ${process.versions.node}`, () => Number(process.versions.node.split('.')[0]) >= 20);
  check('pi 在 PATH 中', () => Boolean(which('pi')) || '(缺)');
  check(`全局 remote-pi (${globalVersion() ?? '未装'})`, () => Boolean(globalVersion()));

  const align = packagesAligned();
  check(`settings.packages 与全局包一致${align.ok ? '' : ` — ${align.reason}`}`, () => align.ok);

  const svc = serviceState();
  check(`supervisor 服务：${svc.state}`, () => svc.installed);

  const daemons = readJson(join(REMOTE_DIR, 'daemons.json'), { daemons: [] })?.daemons ?? [];
  check(`registry 里 ${daemons.length} 个 daemon`, () => daemons.length > 0 || '(没有常驻 daemon)');

  const cfg = readJson(join(REMOTE_DIR, 'config.json'), {}) ?? {};
  check(`relay = ${cfg.relay ?? '(默认)'}`, () => true);

  const legacy = detectLegacy();
  if (legacy.length) {
    console.log('');
    warn(`发现 ${legacy.length} 处旧部署残留：`);
    for (const f of legacy) console.log(`    ${f}`);
    info('清理：node deploy.mjs doctor --clean');
    issues++;
  } else {
    ok('无旧部署残留');
  }

  // 会话体积
  const cwd = resolve(opts.cwd ?? defaultCwd());
  const health = sessionHealth(cwd);
  const tooBig = health.largest && health.largest.size > 20 * 1024 ** 2;
  check(`会话体积 ${fmtBytes(health.bytes)}（${health.files} 个）`, () => !tooBig);
  if (tooBig) info('重置：node deploy.mjs reset-session');

  // relay 可达性
  if (cfg.relay) {
    const r = run(process.execPath, ['-e', `
      const url = process.argv[1];
      const t = setTimeout(() => { console.log('timeout'); process.exit(0); }, 6000);
      fetch(url + '/hello').then(r => { clearTimeout(t); console.log('HTTP ' + r.status); process.exit(0); })
        .catch(e => { clearTimeout(t); console.log('ERR ' + e.message); process.exit(0); });
    `, cfg.relay], { timeout: 15_000 });
    const out = r.stdout || r.stderr;
    // /hello 可能 404，但能连上就说明端口通
    check(`relay 可达性：${out}`, () => !/^ERR|timeout/.test(out));
  }

  console.log('');
  if (issues === 0) ok(bold('未发现问题'));
  else warn(`${issues} 项需要注意`);
  return issues === 0 ? 0 : 1;
}

function cmdResetSession(opts) {
  const cwd = resolve(opts.cwd ?? defaultCwd());
  step('归档当前会话');
  const health = sessionHealth(cwd);
  if (!health.files) {
    warn('没有会话文件');
    return 0;
  }
  console.log(`  ${health.files} 个文件，共 ${fmtBytes(health.bytes)}`);
  const r = resetSession(cwd, { archive: true });
  ok(`已归档 ${r.moved} 个 → ${r.archiveDir}`);
  info('接着重启 daemon 让 --continue 开新会话：node deploy.mjs restart');
  return 0;
}

// ── 参数解析 ────────────────────────────────────────────────────────────────
const HELP = `${bold('remote-pi-daemon')} — 跨平台部署 / 运维 Pi 常驻 agent

${bold('用法')}
  node deploy.mjs <command> [options]

${bold('命令')}
  install          安装全局 CLI + supervisor 服务 + 注册并启动 daemon（默认）
  status           服务 / registry / 运行态 / 会话体积
  logs             看 supervisor 日志（--follow 跟随）
  restart          只重启本目录的 daemon
  stop             只停止本目录的 daemon
  reset-session    归档当前会话（--continue 膨胀导致变慢时用）
  uninstall        卸载 supervisor 服务（--remove-daemon 顺带注销 --purge 清 ~/.pi/remote）
  harden           只加固 Windows 崩溃自愈（LogonTrigger + Repetition 看门狗）
  doctor           全面体检（--clean 顺带清理旧部署残留）

${bold('选项')}
  --cwd <path>     工作目录，默认 ~/workspace/repo/daemon
  --name <name>    agent 名，默认目录名
  --relay <url>    写入 relay（http:// 或 https://）
  --skip-global    不自动 npm install -g remote-pi
  --dry-run        只打印将执行的步骤
  --tail <n>       logs 行数（默认 60）
  --follow, -f     logs 跟随
  --yes, -y        危险操作确认
  --clean          doctor 时清理旧部署残留
  --no-start       只注册不启动（同目录还开着交互式 pi 时用）
  --no-harden      install 时跳过 Windows 崩溃自愈加固（少一次 UAC）

${bold('示例')}
  node deploy.mjs install
  node deploy.mjs install --cwd ~/projects/api --name backend --relay http://100.x.y.z:1247
  node deploy.mjs doctor
  node deploy.mjs logs -f
`;

function parseArgs(argv) {
  const opts = { _: [] };
  const takesValue = new Set(['cwd', 'name', 'relay', 'tail']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (takesValue.has(key)) opts[key] = argv[++i];
      else if (key === 'follow' || key === 'yes' || key === 'dry-run' || key === 'skip-global'
        || key === 'clean' || key === 'purge' || key === 'remove-daemon' || key === 'no-start' || key === 'no-harden') {
        opts[key === 'dry-run' ? 'dryRun' : key === 'skip-global' ? 'skipGlobal'
          : key === 'remove-daemon' ? 'removeDaemon' : key === 'no-start' ? 'noStart' : key === 'no-harden' ? 'noHarden' : key] = true;
      } else if (key === 'help' || key === 'h') opts.help = true;
      else { console.error(`未知选项：${a}`); process.exit(2); }
    } else if (a === '-f') opts.follow = true;
    else if (a === '-y') opts.yes = true;
    else if (a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
const command = opts._[0] ?? 'install';

if (opts.help || command === 'help') {
  console.log(HELP);
  process.exit(0);
}

try {
  let code = 0;
  switch (command) {
    case 'install': code = cmdInstall(opts); break;
    case 'status': code = cmdStatus(opts); break;
    case 'logs': code = cmdLogs(opts); break;
    case 'harden': hardenWindowsService({ dryRun: opts.dryRun }); break;
    case 'restart': code = cmdRestart(opts); break;
    case 'stop': code = cmdStop(opts); break;
    case 'reset-session': code = cmdResetSession(opts); break;
    case 'uninstall': code = cmdUninstall(opts); break;
    case 'doctor':
      if (opts.clean) { step('清理旧部署残留'); cleanLegacy({ dryRun: opts.dryRun }); }
      code = cmdDoctor(opts);
      break;
    default:
      fail(`未知命令：${command}`);
      console.log(HELP);
      code = 2;
  }
  process.exit(code);
} catch (e) {
  console.log('');
  fail(e instanceof DeployError ? e.message : (e?.stack ?? String(e)));
  process.exit(1);
}
