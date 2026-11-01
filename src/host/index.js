/**
 * Host half of dsh-qoder-worktree.
 *
 * Serves git status, worktree creation and removal for the client half over the
 * authenticated /api carrier: exact routes registered on connection.fetch, each
 * answering the client-request/server-response RPC envelope the Connection
 * package's rpc.call expects.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const API_PREFIX = '/api/dsh-qoder-worktree'
const ENDPOINTS = ['status', 'create', 'remove']
const BRANCH_PREFIX = 'qwt'

const ok = (value) => ({ ok: true, value })
const fail = (message) => ({ ok: false, message })

function readClientRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const { type, rpcId, method, payload } = body
  if (type !== 'client-request') return null
  if (typeof rpcId !== 'string' || rpcId === '') return null
  if (typeof method !== 'string' || method === '') return null
  const carried = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  return { type, rpcId, method, payload: carried }
}

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

/** Parse `git worktree list --porcelain` into [{ path, branch, main, bare }]. */
function parseWorktrees(porcelain) {
  const list = []
  let current = null
  for (const raw of porcelain.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      if (current !== null) list.push(current)
      current = null
      continue
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: undefined, main: false, bare: false }
    } else if (current !== null && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length).trim()
    } else if (current !== null && line === 'bare') {
      current.bare = true
    } else if (current !== null && line === 'detached') {
      current.detached = true
    }
  }
  if (current !== null) list.push(current)
  // The first non-bare entry git prints is the main working tree.
  const main = list.find((entry) => !entry.bare)
  if (main !== undefined) main.main = true
  return list
}

async function repoStatus(cwd) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout !== 'true') {
    return { repo: false, branch: undefined, commits: 0, worktrees: [], mainToplevel: undefined }
  }
  const toplevel = await git(cwd, ['rev-parse', '--show-toplevel'])
  const mainToplevel = toplevel.ok ? toplevel.stdout : undefined
  const branchHead = await git(cwd, ['symbolic-ref', '--short', 'HEAD'])
  const branch = branchHead.ok && branchHead.stdout
    ? branchHead.stdout
    : (await git(cwd, ['rev-parse', '--short', 'HEAD'])).stdout || undefined
  const count = await git(cwd, ['rev-list', '--count', 'HEAD'])
  const commits = count.ok ? Number(count.stdout) || 0 : 0
  const list = await git(cwd, ['worktree', 'list', '--porcelain'])
  const worktrees = list.ok ? parseWorktrees(list.stdout) : []
  return { repo: true, branch, commits, worktrees, mainToplevel }
}

async function createWorktree(cwd, name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(name)) {
    throw new Error('任务空间名称只能包含字母、数字、点、下划线和中划线，长度 1-40。')
  }
  const status = await repoStatus(cwd)
  if (!status.repo || !status.mainToplevel) throw new Error('当前目录不是本机 Git 仓库工作树。')
  if (status.commits <= 0) throw new Error('仓库还没有提交，无法创建 Worktree。')
  const repoName = basename(status.mainToplevel)
  const worktreePath = join(dirname(status.mainToplevel), `${repoName}-wt`, name)
  if (existsSync(worktreePath)) throw new Error(`目录已存在：${worktreePath}`)
  const branch = `${BRANCH_PREFIX}/${name}`
  const branchExists = await git(status.mainToplevel, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  const args = branchExists.ok
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath]
  const added = await git(status.mainToplevel, args, 60000)
  if (!added.ok) throw new Error(added.message)
  return { path: worktreePath, branch, name }
}

async function removeWorktree(cwd, target) {
  if (typeof target !== 'string' || !isAbsolute(target)) throw new Error('需要 worktree 的绝对路径。')
  const status = await repoStatus(cwd)
  if (!status.repo) throw new Error('当前目录不是本机 Git 仓库工作树。')
  const entry = status.worktrees.find((item) => canonical(item.path) === canonical(target))
  if (entry === undefined) throw new Error('该目录不是这个仓库的 worktree。')
  if (entry.main) throw new Error('主工作树不能通过这里移除。')
  const removed = await git(status.mainToplevel, ['worktree', 'remove', entry.path], 60000)
  if (!removed.ok) throw new Error(removed.message)
  return { path: entry.path }
}

async function handle(endpoint, payload) {
  if (endpoint === 'status') return ok(await repoStatus(String(payload.cwd ?? '')))
  if (endpoint === 'create') return ok(await createWorktree(String(payload.cwd ?? ''), payload.name))
  if (endpoint === 'remove') return ok(await removeWorktree(String(payload.cwd ?? ''), payload.path))
  return fail(`Unknown endpoint: ${endpoint}`)
}

export function apply(ctx) {
  for (const endpoint of ENDPOINTS) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${API_PREFIX}/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let body
        try { body = await request.json() } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const message = readClientRequest(body)
        if (message === null) return new Response('invalid client-request message', { status: 400 })
        const result = message.method === `dsh-qoder-worktree/${endpoint}`
          ? await handle(endpoint, message.payload).catch((error) => fail(String(error?.message ?? error)))
          : fail('RPC method does not match endpoint.')
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result })
      },
    }), `dsh-qoder-worktree ${endpoint} route`)
  }
}
