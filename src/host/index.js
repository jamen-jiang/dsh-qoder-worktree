/**
 * Host half of dsh-qoder-worktree.
 *
 * Serves git status, worktree creation/removal and "point this session at a
 * directory" over the authenticated /api carrier: exact routes registered on
 * connection.fetch, each answering the client-request/server-response RPC
 * envelope the Connection package's rpc.call expects.
 *
 * 隔离目录用原生 `git worktree add`(与 Qoder/WorkBuddy 一致:会在仓库 .git/
 * worktrees/ 下留注册目录)。会话切目录走 working-directory/change 投影,
 * 会话本身不搬工作区、不新建 Workspace。
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const API_PREFIX = '/api/dsh-qoder-worktree'
const ENDPOINTS = ['status', 'create', 'remove', 'branches', 'fetch', 'branch', 'new-branch', 'use', 'arm', 'arm-cancel']
const BRANCH_PREFIX = 'qwt'
// 会话 → 生效目录 的登记表:会话还没 Agent(空会话)时暂存,agent/created 时补写
// working-directory/change;同时让 status 在 Agent 不在时也能显示 worktree 模式。
const STATE_PATH = join(homedir(), '.dsh', 'qoder-worktree', 'sessions.json')
// 会话 → 待发送意图(arm):切模式/选分支只登记,首条消息进 inbox(agent 真正开跑)时才建 worktree 并切目录。
const ARMS_PATH = join(homedir(), '.dsh', 'qoder-worktree', 'arms.json')
const WORKTREES_ROOT = join(homedir(), '.dsh', 'Worktrees')

const ok = (value) => ({ ok: true, value })
const fail = (message) => ({ ok: false, message })

function canonical(value) {
  const path = resolve(String(value))
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function git(cwd, args, timeoutMs = 10000) {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) resolvePromise({ ok: false, message: String(stderr || error.message || 'git failed').trim() })
      else resolvePromise({ ok: true, stdout: String(stdout).trim() })
    })
  })
}

/** apply() 里赋值的 Host 上下文;模块级单例,仅供下面的辅助函数使用。 */
let ctx

function readStore() {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function writeStore(entry) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(entry, null, 2), 'utf8')
  } catch { /* 登记表只是缓存,写失败不阻塞功能 */ }
}

/** 待发送意图登记表:客户端切模式/选分支时只写这里,发送那一刻才落地。 */
function readArms() {
  try {
    const raw = JSON.parse(readFileSync(ARMS_PATH, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function writeArms(entry) {
  try {
    mkdirSync(dirname(ARMS_PATH), { recursive: true })
    writeFileSync(ARMS_PATH, JSON.stringify(entry, null, 2), 'utf8')
  } catch { /* 同 sessions.json:缓存而已 */ }
}

/**
 * 任务空间档案:目录名改成随机后缀后,光看名字分不出"干净检出"还是"带未提交改动"开的,
 * 所以建的时候记一笔,菜单里的勾选才找得回来。移除任务空间时一起清掉。
 */
const SPACES_PATH = join(homedir(), '.dsh', 'qoder-worktree', 'spaces.json')

function readSpaces() {
  try {
    const raw = JSON.parse(readFileSync(SPACES_PATH, 'utf8'))
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function writeSpace(path, info) {
  const spaces = readSpaces()
  spaces[canonical(path)] = info
  try {
    mkdirSync(dirname(SPACES_PATH), { recursive: true })
    writeFileSync(SPACES_PATH, JSON.stringify(spaces, null, 2), 'utf8')
  } catch { /* 档案丢了只是勾不上,不影响功能 */ }
}

function forgetSpace(path) {
  const spaces = readSpaces()
  if (spaces[canonical(path)] === undefined) return
  delete spaces[canonical(path)]
  try {
    writeFileSync(SPACES_PATH, JSON.stringify(spaces, null, 2), 'utf8')
  } catch { /* 同上 */ }
}

/**
 * 会话的生效工作目录:working-directory/change 投影(宿主 workingDirectory 服务)。
 * Agent 不在(空会话/未加载)时查暂存登记表。都没有则 undefined(= header.cwd,主树)。
 */
function sessionWorkingPath(sessionId) {
  if (!sessionId) return undefined
  const agent = ctx?.agents?.get(sessionId)
  if (agent !== undefined) {
    try {
      const current = ctx.workingDirectory.get(agent.session)
      if (typeof current === 'string' && current) return current
    } catch { /* 投影读不到则回退登记表 */ }
  }
  const stored = readStore()
  return typeof stored[sessionId] === 'string' ? stored[sessionId] : undefined
}

function parseWorktrees(text) {
  const items = []
  let current = null
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) items.push(current)
      current = { path: line.slice('worktree '.length).trim(), detached: false }
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim()
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '').trim()
    } else if (current && line.trim() === 'detached') {
      current.detached = true
    }
  }
  if (current) items.push(current)
  return items.map((item, index) => ({ ...item, main: index === 0 }))
}

async function repoStatus(cwd, sessionId) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout !== 'true') {
    return { repo: false, branch: undefined, commits: 0, worktrees: [], mainToplevel: undefined }
  }
  // 会话生效目录(可能指向别的 worktree)优先:分支/改动数按那个目录算,状态才反映真实工作位置。
  const workingPath = sessionWorkingPath(sessionId)
  const dir = workingPath !== undefined && existsSync(workingPath) ? workingPath : cwd
  // 五个 git 调用互不依赖,并行跑:Windows 进程启动贵,串行一次 status 要 300-900ms。
  const [toplevel, list, branch, count, porcelain] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['worktree', 'list', '--porcelain']),
    git(dir, ['symbolic-ref', '--short', 'HEAD']),
    git(dir, ['rev-list', '--count', 'HEAD']),
    git(dir, ['status', '--porcelain']),
  ])
  const worktrees = parseWorktrees(list.ok ? list.stdout : '')
  // 主树路径必须取 worktree 列表里 main 那条:show-toplevel 在 worktree 内会返回 worktree 自己的路径。
  const mainToplevel = worktrees.find((item) => item.main)?.path ?? (toplevel.ok ? toplevel.stdout : undefined)
  const branchValue = branch.ok ? branch.stdout : undefined
  const commits = count.ok ? Number(count.stdout) || 0 : 0
  const changes = porcelain.ok ? porcelain.stdout.split('\n').filter((line) => line.trim()).length : 0
  // 待发送意图(切了模式还没发消息):客户端据此乐观显示"Worktree 模式"。
  const arm = sessionId !== undefined && sessionId !== '' ? readArms()[sessionId] ?? null : null
  // 当前生效目录是哪个任务空间、当初带没带未提交改动(菜单里「本地文件状态」的勾靠这个找回来)。
  const carryWorking = readSpaces()[canonical(dir)]?.carry === true
  return { repo: true, branch: branchValue, commits, changes, worktrees, mainToplevel, workingPath, arm, carryWorking }
}

function dirNameFor(ref) {
  const name = ref.split('/').join('-')
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(name) ? name : undefined
}

/** WorkBuddy 同款命名:分支 slug + 8 位随机 hex,每次都不一样(靠随机数防撞,不靠提交号)。 */
function uid8() {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

function slugifyRef(ref) {
  return (dirNameFor(ref) ?? ref.split('/').join('-'))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'worktree'
}

/**
 * 从分支建隔离 worktree(原生 git worktree)。分支已被别处检出时 git 会拒绝,
 * 退一步 --detach 检出同一提交——主树占着 main 是常态。
 * options.carry=true 表示"本地文件状态":建好后把源目录里未提交的改动(含未跟踪文件)搬过来。
 */
async function createWorktreeFromBranch(cwd, ref, options = {}) {
  const carry = options.carry === true
  if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(ref) || ref.includes('..') || ref.endsWith('/')) {
    throw new Error('分支名不合法。')
  }
  const status = await repoStatus(cwd)
  if (!status.repo || !status.mainToplevel) throw new Error('当前目录不是本机 Git 仓库工作树。')
  if (status.commits <= 0) throw new Error('仓库还没有提交，无法创建 Worktree。')
  const sha = await git(status.mainToplevel, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!sha.ok || !sha.stdout) throw new Error(`分支不存在：${ref}`)
  // 每次选都开一个新任务空间(WorkBuddy 语义):`<分支>-<8位随机>`,带不带未提交改动同名同规。
  const slug = slugifyRef(ref)
  const repoDir = join(WORKTREES_ROOT, basename(status.mainToplevel))
  let dirName = ''
  let worktreePath = ''
  for (let attempt = 0; attempt < 6; attempt++) {
    dirName = `${slug}-${uid8()}`
    worktreePath = join(repoDir, dirName)
    if (!existsSync(worktreePath) && !status.worktrees.some((item) => canonical(item.path) === canonical(worktreePath))) break
    if (attempt === 5) throw new Error('任务空间目录名连续撞车，请重试。')
  }
  mkdirSync(dirname(worktreePath), { recursive: true })
  const added = await addWorktree(status.mainToplevel, worktreePath, ref)
  if (!added.ok) {
    // 多半是"already checked out"——同一分支被主树/别的 worktree 占用,detach 到同一提交。
    const detached = await addWorktree(status.mainToplevel, worktreePath, ref, true)
    if (!detached.ok) {
      rmSync(worktreePath, { recursive: true, force: true })
      throw new Error(added.message || detached.message)
    }
    if (carry) await carryLocalChanges(options.from ?? cwd, worktreePath)
    writeSpace(worktreePath, { carry, ref, createdAt: Date.now() })
    return { path: worktreePath, branch: undefined, detached: true, name: dirName }
  }
  if (carry) await carryLocalChanges(options.from ?? cwd, worktreePath)
  writeSpace(worktreePath, { carry, ref, createdAt: Date.now() })
  return { path: worktreePath, branch: ref, name: dirName }
}

/**
 * `git worktree add`:大仓库检出可能很慢,超时给到 5 分钟。
 * 任务空间目录被手工删过/上次中断会留下"注册了但目录不存在"的僵尸项,git 会直接拒绝
 * add(missing but already registered),这时先 prune 再试一次,不然永远建不出来。
 */
async function addWorktree(toplevel, path, ref, detach = false) {
  const args = detach ? ['worktree', 'add', '--detach', path, ref] : ['worktree', 'add', path, ref]
  const first = await git(toplevel, args, 300000)
  if (first.ok || !/already registered/.test(first.message ?? '')) return first
  await git(toplevel, ['worktree', 'prune'], 30000)
  return git(toplevel, args, 300000)
}

/**
 * 把 src 里"改了还没提交"的东西搬进 dst:已跟踪文件走 `git diff HEAD --output` 补丁
 * (二进制安全:补丁由 git 自己写盘,不过我们的字符串管道),未跟踪文件逐个复制。
 */
async function carryLocalChanges(src, dst) {
  if (!src || !existsSync(src) || canonical(src) === canonical(dst)) return
  const patch = join(tmpdir(), `qwt-carry-${Date.now().toString(36)}.patch`)
  const diff = await git(src, ['diff', 'HEAD', '--binary', `--output=${patch}`], 60000)
  if (!diff.ok) throw new Error(diff.message)
  try {
    if (existsSync(patch) && statSync(patch).size > 0) {
      const applied = await git(dst, ['apply', '--whitespace=nowarn', patch.replace(/\\/g, '/')], 60000)
      if (!applied.ok) throw new Error(`未提交的改动搬不过去：${applied.message}`)
    }
  } finally {
    try { if (existsSync(patch)) rmSync(patch) } catch { /* 临时文件删不掉不影响结果 */ }
  }
  const others = await git(src, ['ls-files', '--others', '--exclude-standard', '-z'], 30000)
  if (!others.ok) return
  for (const relative of others.stdout.split('\0').filter(Boolean)) {
    const from = join(src, relative)
    const to = join(dst, relative)
    try {
      if (!statSync(from).isFile()) continue
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    } catch { /* 单个文件搬不动(占用/权限)就跳过,别整个失败 */ }
  }
}

async function createWorktree(cwd, name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(name)) {
    throw new Error('任务空间名称只能包含字母、数字、点、下划线和中划线，长度 1-40。')
  }
  const status = await repoStatus(cwd)
  if (!status.repo || !status.mainToplevel) throw new Error('当前目录不是本机 Git 仓库工作树。')
  if (status.commits <= 0) throw new Error('仓库还没有提交，无法创建 Worktree。')
  const branch = `${BRANCH_PREFIX}/${name}`
  const branchExists = await git(status.mainToplevel, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (!branchExists.ok) {
    const created = await git(status.mainToplevel, ['branch', branch, 'HEAD'], 30000)
    if (!created.ok) throw new Error(created.message)
  }
  return createWorktreeFromBranch(cwd, branch)
}

async function removeWorktree(cwd, target) {
  if (typeof target !== 'string' || !isAbsolute(target)) throw new Error('需要 worktree 的绝对路径。')
  const status = await repoStatus(cwd)
  if (!status.repo || !status.mainToplevel) throw new Error('当前目录不是本机 Git 仓库工作树。')
  const item = status.worktrees.find((entry) => canonical(entry.path) === canonical(target))
  if (item === undefined || item.main) throw new Error('该目录不是这个仓库的任务空间。')
  const removed = await git(status.mainToplevel, ['worktree', 'remove', item.path], 60000)
  if (!removed.ok) throw new Error(removed.message)
  forgetSpace(item.path)
  return { path: item.path }
}

async function listBranches(cwd) {
  const status = await repoStatus(cwd)
  if (!status.repo || !status.mainToplevel) throw new Error('当前目录不是本机 Git 仓库工作树。')
  const local = await git(status.mainToplevel, ['for-each-ref', 'refs/heads', '--format=%(refname:lstrip=2)'])
  const remote = await git(status.mainToplevel, ['for-each-ref', 'refs/remotes', '--format=%(refname:lstrip=2)'])
  const split = (out) => out.ok && out.stdout ? out.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
  return {
    local: split(local),
    remote: split(remote).filter((ref) => !ref.endsWith('/HEAD')),
    current: status.branch,
    worktrees: status.worktrees,
    mainToplevel: status.mainToplevel,
  }
}

async function fetchBranches(cwd) {
  const status = await repoStatus(cwd)
  if (!status.repo || !status.mainToplevel) throw new Error('当前目录不是本机 Git 仓库工作树。')
  const fetched = await git(status.mainToplevel, ['fetch', '--all', '--prune'], 120000)
  if (!fetched.ok) throw new Error(fetched.message)
  return { fetched: true }
}

/** Create a brand-new local branch at HEAD and check it out in a fresh worktree (Qoder「新建分支」). */
async function createBranch(cwd, name) {
  if (typeof name !== 'string') throw new Error('分支名不合法。')
  const trimmed = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(trimmed) || trimmed.includes('..') || trimmed.endsWith('/') || trimmed.endsWith('.lock')) {
    throw new Error('分支名只能包含字母、数字、点、下划线和中划线。')
  }
  const status = await repoStatus(cwd)
  if (!status.repo || !status.mainToplevel) throw new Error('当前目录不是本机 Git 仓库工作树。')
  if (status.commits <= 0) throw new Error('仓库还没有提交，无法创建分支。')
  const exists = await git(status.mainToplevel, ['rev-parse', '--verify', '--quiet', `refs/heads/${trimmed}`])
  if (exists.ok) throw new Error(`分支已存在：${trimmed}`)
  const created = await git(status.mainToplevel, ['branch', trimmed, 'HEAD'], 30000)
  if (!created.ok) throw new Error(created.message)
  return createWorktreeFromBranch(cwd, trimmed)
}

/** 只写投影不注入系统消息:workingDirectory.set 会额外插一条"目录已变更"用户消息,空会话首条 turn 前不想要它。 */
async function applyWorking(agent, path) {
  const current = (() => { try { return ctx.workingDirectory.get(agent.session) } catch { return undefined } })()
  if (current !== undefined && canonical(current) === canonical(path)) return
  await agent.session.append('working-directory/change', { cwd: path })
}

/**
 * 当前会话原地指向 path(worktree 或主树):不建工作区、不切会话。
 * Agent 已存在立即生效;空会话登记进表,agent/created 时补写(发送那一刻才建 Agent)。
 */
async function pointSession(sessionId, path) {
  if (!sessionId) throw new Error('缺少 sessionId。')
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('需要目标目录的绝对路径。')
  const entry = readStore()
  if (!existsSync(path)) {
    delete entry[sessionId]
    writeStore(entry)
    return { deferred: false, missing: true }
  }
  const agent = ctx.agents.get(sessionId)
  if (agent !== undefined) {
    await applyWorking(agent, path)
    delete entry[sessionId]
    writeStore(entry)
    return { deferred: false }
  }
  entry[sessionId] = path
  writeStore(entry)
  return { deferred: true }
}

/**
 * 登记"待发送意图":模式/分支切换只写这里,不建目录也不改会话目录。
 * mode=worktree 需要 ref(已有分支)或 newBranch(发送时再建分支);mode=local 表示回主树。
 * carry=true 表示选的是"本地文件状态":建好后还要把未提交的改动一起搬进任务空间。
 */
async function armSession(sessionId, payload) {
  if (!sessionId) throw new Error('缺少 sessionId。')
  const mode = String(payload.mode ?? '')
  if (mode !== 'worktree' && mode !== 'local') throw new Error('未知的模式。')
  const cwd = String(payload.cwd ?? '')
  if (!cwd) throw new Error('缺少工作目录。')
  const arms = readArms()
  if (mode === 'local') {
    arms[sessionId] = { mode, cwd }
  } else {
    const ref = typeof payload.ref === 'string' && payload.ref ? payload.ref : undefined
    const newBranch = typeof payload.newBranch === 'string' && payload.newBranch ? payload.newBranch : undefined
    if (ref === undefined && newBranch === undefined) throw new Error('缺少目标分支。')
    arms[sessionId] = { mode, cwd, ref, newBranch, carry: payload.carry === true ? true : undefined }
  }
  writeArms(arms)
  return arms[sessionId]
}

function cancelArm(sessionId) {
  const arms = readArms()
  if (arms[sessionId] === undefined) return { cancelled: false }
  delete arms[sessionId]
  writeArms(arms)
  return { cancelled: true }
}

/** 发送那一刻落地:建 worktree(或回主树)并把会话生效目录原地切过去。 */
async function consumeArm(agent) {
  const arms = readArms()
  const arm = arms[agent.session.id]
  if (arm === undefined) return
  delete arms[agent.session.id]
  writeArms(arms)
  try {
    if (arm.mode === 'local') {
      const status = await repoStatus(arm.cwd)
      if (status.mainToplevel) await applyWorking(agent, status.mainToplevel)
      return
    }
    const created = arm.newBranch
      ? await createBranch(arm.cwd, arm.newBranch)
      : await createWorktreeFromBranch(arm.cwd, arm.ref, arm.carry === true
        ? { carry: true, from: await currentWorkingDir(arm.cwd, agent.session.id) }
        : undefined)
    await applyWorking(agent, created.path)
  } catch (error) {
    const message = String(error?.message ?? error)
    console.warn('[qwt] 发送时切入 Worktree 失败:', error)
    // 失败必须看得见:把原因写回登记(repoStatus 会带出来给菜单),用户换一项就覆盖掉。
    const latest = readArms()
    latest[agent.session.id] = { ...(latest[agent.session.id] ?? arm), error: message }
    writeArms(latest)
  }
}

/** 会话当前生效目录(未提交改动就在那儿):投影优先,回退工作区 cwd。 */
async function currentWorkingDir(cwd, sessionId) {
  const working = sessionWorkingPath(sessionId)
  if (working !== undefined && existsSync(working)) return working
  const status = await repoStatus(cwd)
  return status.workingPath && existsSync(status.workingPath) ? status.workingPath : cwd
}

async function handle(endpoint, payload) {
  if (endpoint === 'status') return ok(await repoStatus(String(payload.cwd ?? ''), String(payload.sessionId ?? '')))
  if (endpoint === 'create') return ok(await createWorktree(String(payload.cwd ?? ''), payload.name))
  if (endpoint === 'remove') return ok(await removeWorktree(String(payload.cwd ?? ''), payload.path))
  if (endpoint === 'branches') return ok(await listBranches(String(payload.cwd ?? '')))
  if (endpoint === 'fetch') return ok(await fetchBranches(String(payload.cwd ?? '')))
  if (endpoint === 'branch') return ok(await createWorktreeFromBranch(String(payload.cwd ?? ''), payload.ref))
  if (endpoint === 'new-branch') return ok(await createBranch(String(payload.cwd ?? ''), payload.name))
  if (endpoint === 'use') return ok(await pointSession(String(payload.sessionId ?? ''), String(payload.path ?? '')))
  if (endpoint === 'arm') return ok(await armSession(String(payload.sessionId ?? ''), payload))
  if (endpoint === 'arm-cancel') return ok(cancelArm(String(payload.sessionId ?? '')))
  return fail(`Unknown endpoint: ${endpoint}`)
}

export const inject = ['connection', 'agents', 'workingDirectory']

export function apply(hostCtx) {
  ctx = hostCtx
  // 空会话期登记的"待生效目录":Agent 建立(首次发送)时补写投影。serial 事件在首步组装前完成。
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    const entry = readStore()
    const target = entry[agent.session.id]
    if (target === undefined) return
    delete entry[agent.session.id]
    writeStore(entry)
    if (!existsSync(target)) return
    return applyWorking(agent, target).catch((error) => console.warn('[qwt] 切入 worktree 失败:', error))
  }), 'dsh-qoder-worktree agent/created')
  // 待发送意图(arm):消息进 inbox = 用户点了发送,这一刻才建 worktree / 回主树并切生效目录。
  ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent }) => {
    void consumeArm(agent)
  }), 'dsh-qoder-worktree agent/inbox/inserted')
  // 新版 connection.fetch 要精确 HTTP 路由 {path, methods, requestBody, fetch};
  // 旧版 {request, handler} 会在 assertFetchRoute 里对 undefined 的 path 调 startsWith 直接炸。
  for (const endpoint of ENDPOINTS) {
    ctx.connection.fetch.register({
      path: `${API_PREFIX}/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let message
        try {
          message = await request.json()
        } catch {
          return Response.json({ type: 'server-response', rpcId: '', result: fail('请求体不是 JSON。') })
        }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : ''
        if (message?.type !== 'client-request' || message?.method !== `dsh-qoder-worktree/${endpoint}`) {
          return Response.json({ type: 'server-response', rpcId, result: fail(`期望 method "dsh-qoder-worktree/${endpoint}"。`) })
        }
        try {
          const payload = message.payload !== null && typeof message.payload === 'object' && !Array.isArray(message.payload) ? message.payload : {}
          const result = await handle(endpoint, payload)
          return Response.json({ type: 'server-response', rpcId, result })
        } catch (error) {
          return Response.json({ type: 'server-response', rpcId, result: fail(String(error?.message ?? error)) })
        }
      },
    })
  }
  return undefined
}
