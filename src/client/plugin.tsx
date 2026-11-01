import { useCallback, useEffect, useRef, useState } from "react"
import css from "./styles.css"

const CHANNEL = "/api"
const PREFIX = "dsh-qoder-worktree"
const STYLE_TAG = "data-dsh-qoder-worktree-style"
const NO_BRANCH = "没有可用的本地分支"
const WORKTREE_HINT = "请选择已有提交且支持 Worktree 的本机 Git Workspace"

type Status = {
  repo: boolean
  branch?: string
  commits: number
  worktrees: Array<{ path: string, branch?: string, main: boolean }>
  mainToplevel?: string
}

type Connection = { rpc: { call: (...args: unknown[]) => Promise<any> } }

type ClientContext = {
  effect: (fn: () => () => void, label?: string) => void
  connection: Connection
  workspaces: { create: (input: { path: string }) => Promise<{ workspaceId: string }> }
  uiWorkspace: { openWorkspace: (workspaceId: string) => Promise<void> }
  slots: {
    inject: (name: string, factory: () => { unregister: () => void } | undefined) => () => void
    register: (options: Record<string, unknown>, component: unknown) => { unregister: () => void }
  }
}

function createApi(connection: Connection) {
  async function call(endpoint: string, payload: Record<string, unknown>): Promise<any> {
    const result = await connection.rpc.call(CHANNEL, `${PREFIX}/${endpoint}`, payload) as any
    if (!result?.ok) throw new Error(result?.message ?? "请求失败")
    return result.value
  }
  return {
    status: (cwd: string) => call("status", { cwd }) as Promise<Status>,
    create: (cwd: string, name: string) => call("create", { cwd, name }),
    remove: (cwd: string, path: string) => call("remove", { cwd, path }),
  }
}

function samePath(a?: string, b?: string) {
  if (!a || !b) return false
  const left = a.replace(/[\\/]+$/, "")
  const right = b.replace(/[\\/]+$/, "")
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function installStyles() {
  if (typeof document === "undefined" || document.querySelector(`style[${STYLE_TAG}]`)) return () => {}
  const style = document.createElement("style")
  style.setAttribute(STYLE_TAG, "")
  style.textContent = css
  document.head.appendChild(style)
  return () => style.remove()
}

function useOutsideDismiss(open: boolean, onDismiss: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss()
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open, onDismiss])
  return ref
}

function basename(path?: string) {
  if (!path) return ""
  const trimmed = path.replace(/[\\/]+$/, "")
  const at = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

type OpenActions = {
  workspacesCreate: (path: string) => Promise<{ workspaceId: string }>
  openWorkspace: (workspaceId: string) => Promise<void>
}

function ModeChip(props: {
  api: ReturnType<typeof createApi>
  open: OpenActions
  status?: Status
  cwd?: string
}) {
  const { api, open, status, cwd } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const ref = useOutsideDismiss(menuOpen, useCallback(() => setMenuOpen(false), []))

  const repo = status?.repo === true
  const hasCommits = (status?.commits ?? 0) > 0
  const canWorktree = repo && hasCommits
  const inWorktree = status?.worktrees.some((item) => !item.main && samePath(item.path, cwd)) === true

  async function openPath(path: string | undefined) {
    if (!path) return
    setError(undefined)
    setBusy(true)
    try {
      const workspace = await open.workspacesCreate(path)
      await open.openWorkspace(workspace.workspaceId)
      setMenuOpen(false)
    } catch (cause) {
      setError(String((cause as Error).message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (!cwd || !draft.trim() || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const created = await api.create(cwd, draft.trim())
      setDraft("")
      await openPath(created.path)
    } catch (cause) {
      setError(String((cause as Error).message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  const worktrees = (status?.worktrees ?? []).filter((item) => !item.main)

  return (
    <div ref={ref} className="qwt-chip" onClick={() => { setError(undefined); setMenuOpen((v) => !v) }}>
      <span className="qwt-glyph">◫</span>
      <span>{inWorktree ? "Worktree 模式" : "本地模式"}</span>
      <span className="qwt-caret">▾</span>
      {menuOpen && (
        <div className="qwt-menu" onClick={(event) => event.stopPropagation()}>
          <div
            className="qwt-item"
            data-active={String(!inWorktree)}
            title={repo && status?.mainToplevel ? status.mainToplevel : undefined}
            onClick={() => (inWorktree ? void openPath(status?.mainToplevel) : setMenuOpen(false))}
          >
            <span className="qwt-glyph">◫</span>
            <span>本地模式</span>
            {repo && status?.mainToplevel ? <span className="qwt-sub">{basename(status.mainToplevel)}</span> : undefined}
          </div>
          {canWorktree ? (
            worktrees.map((item) => (
              <div
                key={item.path}
                className="qwt-item"
                data-active={String(samePath(item.path, cwd))}
                title={item.path}
                onClick={() => (samePath(item.path, cwd) ? setMenuOpen(false) : void openPath(item.path))}
              >
                <span className="qwt-glyph">⑂</span>
                <span>{basename(item.path)}</span>
                <span className="qwt-sub">{item.branch ?? "detached"}</span>
                <span
                  className="qwt-remove"
                  title="移除该 worktree"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (!cwd) return
                    setBusy(true)
                    setError(undefined)
                    api.remove(cwd, item.path)
                      .catch((cause: unknown) => setError(String((cause as Error).message ?? cause)))
                      .finally(() => setBusy(false))
                  }}
                >
                  移除
                </span>
              </div>
            ))
          ) : (
            <div
              className="qwt-item"
              data-disabled="true"
              title={WORKTREE_HINT}
              onClick={(event) => event.stopPropagation()}
            >
              <span className="qwt-glyph">⑂</span>
              <span>Worktree 模式</span>
            </div>
          )}
          {canWorktree && (
            <>
              <div className="qwt-divider" />
              <div className="qwt-create">
                <input
                  placeholder="新建 Worktree 名称…"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void submit() }}
                />
                <button disabled={busy || !draft.trim()} onClick={() => void submit()}>创建</button>
              </div>
            </>
          )}
          {!repo && <div className="qwt-empty">当前会话目录不是 Git 仓库工作树。</div>}
          {repo && !hasCommits && <div className="qwt-empty">仓库还没有提交，无法创建 Worktree。</div>}
          {busy && !error && <div className="qwt-empty">正在处理…</div>}
          {error && <div className="qwt-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

function BranchChip(props: { status?: Status, cwd?: string }) {
  const { status, cwd } = props
  const label = status?.repo && status.branch ? status.branch : NO_BRANCH
  return (
    <div className="qwt-branch" title={cwd ?? NO_BRANCH}>
      <span className="qwt-glyph">⑂</span>
      <span>{label}</span>
    </div>
  )
}

function QoderBar(props: {
  api: ReturnType<typeof createApi>
  open: OpenActions
  sessionId?: string
  useSessions: (selector: (state: any) => unknown) => unknown
}) {
  const { api, open, sessionId, useSessions } = props
  const cwd = useSessions((state: any) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)) as string | undefined
  const [status, setStatus] = useState<Status | undefined>(undefined)

  useEffect(() => {
    if (!cwd) return undefined
    let alive = true
    const poll = async () => {
      try {
        const next = await api.status(cwd)
        if (alive) setStatus(next)
      } catch { /* the next tick retries */ }
    }
    void poll()
    const timer = setInterval(poll, 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [cwd])

  if (sessionId === undefined) return null
  return (
    <div className="qwt-row">
      <ModeChip api={api} open={open} status={status} cwd={cwd} />
      <BranchChip status={status} cwd={cwd} />
    </div>
  )
}

export const QoderWorktreePlugin = {
  name: "dsh-qoder-worktree",
  inject: ["slots", "connection", "workspaces", "uiWorkspace", "sessions"],
  apply(ctx: ClientContext & Record<string, any>) {
    ctx.effect(installStyles, "dsh-qoder-worktree styles")
    const api = createApi(ctx.connection)
    const open: OpenActions = {
      workspacesCreate: (path: string) => ctx.workspaces.create({ path }),
      openWorkspace: (workspaceId: string) => ctx.uiWorkspace.openWorkspace(workspaceId),
    }

    ctx.slots.inject("conversation.hero.options", () => ctx.slots.register(
      {
        name: "conversation.hero.options",
        id: "qoder-worktree",
        order: 90,
        label: "Qoder worktree",
      },
      (props: any) => (
        <QoderBar
          api={api}
          open={open}
          sessionId={props.sessionId}
          useSessions={props.useSessions}
        />
      ),
    ))
  },
}

export default QoderWorktreePlugin
