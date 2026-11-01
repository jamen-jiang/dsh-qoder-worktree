import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import css from "./styles.css"

const CHANNEL = "/api"
const PREFIX = "dsh-qoder-worktree"
const STYLE_TAG = "data-dsh-qoder-worktree-style"
const NOT_REPO = "当前会话目录不是 Git 仓库工作树。"

type Status = {
  repo: boolean
  branch?: string
  commits: number
  changes?: number
  worktrees: Array<{ path: string, branch?: string, main: boolean }>
  mainToplevel?: string
}

type Branches = {
  local: string[]
  remote: string[]
  current?: string
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
    branches: (cwd: string) => call("branches", { cwd }) as Promise<Branches>,
    fetch: (cwd: string) => call("fetch", { cwd }),
    branch: (cwd: string, ref: string) => call("branch", { cwd, ref }),
    create: (cwd: string, name: string) => call("create", { cwd, name }),
    remove: (cwd: string, path: string) => call("remove", { cwd, path }),
  }
}

function samePath(a?: string, b?: string) {
  if (!a || !b) return false
  const norm = (value: string) => value.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()
  // 浏览器客户端没有 process,用路径本身识别 Windows(盘符或反斜杠)。
  const windows = /^[A-Za-z]:[\\/]/.test(a) || /^[A-Za-z]:[\\/]/.test(b)
  return windows ? norm(a) === norm(b) : a === b
}

function installStyles() {
  if (typeof document === "undefined" || document.querySelector(`style[${STYLE_TAG}]`)) return () => {}
  const style = document.createElement("style")
  style.setAttribute(STYLE_TAG, "")
  style.textContent = css
  document.head.appendChild(style)
  return () => style.remove()
}

function IconBranch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6.5" cy="6" r="2.4" />
      <circle cx="17.5" cy="6" r="2.4" />
      <circle cx="6.5" cy="18" r="2.4" />
      <line x1="6.5" y1="8.4" x2="6.5" y2="15.6" />
      <path d="M17.5 8.4 C17.5 12, 12.5 13, 6.5 13" />
    </svg>
  )
}

function IconLocal() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

function IconChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5 9.5 18 20 6.5" />
    </svg>
  )
}

function IconX() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
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

// 「Worktree 模式」只是标记,不马上建工作区;等用户真正发送消息时由 SessionBar 创建并跳转。
const pendingWorktree: { cwd?: string } = {}

function BranchMenu(props: {
  api: ReturnType<typeof createApi>
  open: OpenActions
  status?: Status
  cwd?: string
  onBack?: () => void
  onClose: () => void
}) {
  const { api, open, status, cwd, onBack, onClose } = props
  const [query, setQuery] = useState("")
  const [branches, setBranches] = useState<Branches | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const loadBranches = useCallback(() => {
    if (!cwd) return
    let alive = true
    api.branches(cwd)
      .then((next) => { if (alive) setBranches(next) })
      .catch(() => { /* 菜单保持已加载内容 */ })
    return () => { alive = false }
  }, [api, cwd])

  useEffect(() => loadBranches(), [loadBranches])

  const repo = status?.repo === true
  const inWorktree = status?.worktrees.some((item) => !item.main && samePath(item.path, cwd)) === true
  const needle = query.trim().toLowerCase()
  const locals = (branches?.local ?? []).filter((name) => !needle || name.toLowerCase().includes(needle))

  // 分组头吸顶时加 data-stuck(宿主 observeStickyMenuGroups 的简化版)。
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const onScroll = () => {
      const top = list.getBoundingClientRect().top
      for (const heading of list.querySelectorAll<HTMLElement>("[data-qwt-heading]")) {
        heading.toggleAttribute("data-stuck", heading.getBoundingClientRect().top <= top + 1 && list.scrollTop > 0)
      }
    }
    list.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => list.removeEventListener("scroll", onScroll)
  }, [repo, needle === ""])

  async function openPath(path: string | undefined) {
    if (!path) return
    setError(undefined)
    setBusy(true)
    try {
      const workspace = await open.workspacesCreate(path)
      await open.openWorkspace(workspace.workspaceId)
      onClose()
    } catch (cause) {
      setError(String((cause as Error).message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  async function pickBranch(ref: string) {
    if (!cwd || busy) return
    const existing = (branches?.worktrees ?? []).find((item) => !item.main && item.branch === ref)
    if (existing) return void openPath(existing.path)
    if (!inWorktree && ref === (branches?.current ?? status?.branch)) return void openPath(branches?.mainToplevel ?? status?.mainToplevel)
    setError(undefined)
    setBusy(true)
    try {
      const created = await api.branch(cwd, ref)
      await openPath(created.path)
    } catch (cause) {
      setError(String((cause as Error).message ?? cause))
      setBusy(false)
    }
  }

  return (
    <>
      {onBack && (
        <div className="qwt-back" onClick={onBack}>
          <span className="qwt-backIcon"><IconChevron /></span>
          <span>选择模式</span>
        </div>
      )}
      <div className="qwt-searchRow">
        <input
          ref={searchRef}
          className="qwt-search"
          placeholder="搜索分支…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") onClose() }}
        />
        {query !== "" && (
          <button
            type="button"
            className="qwt-searchClear"
            title="清除搜索"
            onClick={() => { setQuery(""); searchRef.current?.focus() }}
          >
            <IconX />
          </button>
        )}
      </div>
      {!repo ? (
        <div className="qwt-empty">{NOT_REPO}</div>
      ) : (
        <div className="qwt-list" ref={listRef}>
          {needle === "" && (
            <section className="qwt-group">
              <span className="qwt-groupStart" aria-hidden="true" />
              <div className="qwt-groupHeading" data-qwt-heading>本地文件状态</div>
              <div
                className="qwt-item"
                data-active={String(!inWorktree)}
                title={branches?.mainToplevel ?? status?.mainToplevel}
                onClick={() => void openPath(branches?.mainToplevel ?? status?.mainToplevel)}
              >
                <span className="qwt-glyph"><IconBranch /></span>
                <span>{branches?.current ?? status?.branch}</span>
                <span className="qwt-sub">{(status?.changes ?? 0) > 0 ? "含本地代码更改" : "没有本地代码更改"}</span>
                {!inWorktree && <span className="qwt-check"><IconCheck /></span>}
              </div>
            </section>
          )}
          <section className="qwt-group">
            <span className="qwt-groupStart" aria-hidden="true" />
            <div className="qwt-groupHeading" data-qwt-heading>本地分支</div>
            {locals.map((name) => (
              <div
                key={name}
                className="qwt-item"
                data-active={String(name === (branches?.current ?? status?.branch))}
                title={name}
                onClick={() => void pickBranch(name)}
              >
                <span className="qwt-glyph"><IconBranch /></span>
                <span>{name}</span>
                {name === (branches?.current ?? status?.branch) && <span className="qwt-check"><IconCheck /></span>}
              </div>
            ))}
            {locals.length === 0 && <div className="qwt-empty">没有匹配的本地分支</div>}
          </section>
        </div>
      )}
      {error && <div className="qwt-error">{error}</div>}
    </>
  )
}

function useWorktreeStatus(api: ReturnType<typeof createApi>, cwd?: string) {
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
  }, [api, cwd])
  return status
}

function useAnchorDismiss(menuOpen: boolean, chipRef: { current: HTMLElement | null }, menuRef: { current: HTMLElement | null }, close: () => void) {
  useEffect(() => {
    if (!menuOpen) return undefined
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (chipRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      close()
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [menuOpen])
}

// 顶行(新会话)模式 chip:菜单只有「本地模式 / Worktree 模式」两项;选 Worktree 模式时唤起右侧分支 chip 的下拉。
function ModeChip(props: {
  api: ReturnType<typeof createApi>
  open: OpenActions
  status?: Status
  cwd?: string
}) {
  const { api, open, status, cwd } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchorStyle, setAnchorStyle] = useState<{ left: number, top: number, transform?: string } | undefined>(undefined)
  const chipRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useAnchorDismiss(menuOpen, chipRef, menuRef, () => setMenuOpen(false))
  useEffect(() => {
    if (!menuOpen) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [menuOpen])

  const repo = status?.repo === true
  const inWorktree = status?.worktrees.some((item) => !item.main && samePath(item.path, cwd)) === true
  const [, setPendingTick] = useState(0)
  const pending = cwd !== undefined && pendingWorktree.cwd !== undefined && samePath(pendingWorktree.cwd, cwd)

  // 与宿主工作区下拉一致,默认贴在 chip 下方;底部放不下且上方有空间时才向上翻。
  function anchorBelow() {
    if (!chipRef.current) return
    const rect = chipRef.current.getBoundingClientRect()
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - 300))
    const flip = rect.bottom + 324 > window.innerHeight && rect.top > window.innerHeight - rect.bottom
    setAnchorStyle(flip
      ? { left, top: rect.top - 4, transform: "translateY(-100%)" }
      : { left, top: rect.bottom + 4, transform: "none" })
  }

  function toggle() {
    if (!menuOpen) anchorBelow()
    setMenuOpen((value) => !value)
  }

  async function goLocal() {
    pendingWorktree.cwd = undefined
    setPendingTick((value) => value + 1)
    const target = status?.mainToplevel
    if (!target) return
    try {
      const workspace = await open.workspacesCreate(target)
      await open.openWorkspace(workspace.workspaceId)
      setMenuOpen(false)
    } catch { /* 菜单留着,下次再试 */ }
  }

  function pickWorktreeMode() {
    // 只标记 Worktree 模式,不马上建工作区;等用户发送消息时才创建(SessionBar 负责)。
    if (!repo || inWorktree || !status?.branch) return
    pendingWorktree.cwd = cwd
    setMenuOpen(false)
    setPendingTick((value) => value + 1)
  }

  return (
    <div ref={chipRef} className="qwt-chip" data-open={String(menuOpen)} onClick={toggle}>
      <span className="qwt-glyph">{inWorktree || pending ? <IconBranch /> : <IconLocal />}</span>
      <span>{inWorktree || pending ? "Worktree 模式" : "本地模式"}</span>
      <span className="qwt-caret"><IconChevron /></span>
      {menuOpen && anchorStyle && createPortal(
        <div
          ref={menuRef}
          className="qwt-menu qwt-mode-menu"
          style={anchorStyle}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="qwt-list">
            <div className="qwt-item" data-active={String(!inWorktree && !pending)} onClick={() => void goLocal()}>
              <span className="qwt-glyph"><IconLocal /></span>
              <span>本地模式</span>
              {(!inWorktree && !pending) && <span className="qwt-check"><IconCheck /></span>}
            </div>
            <div
              className="qwt-item"
              data-active={String(inWorktree || pending)}
              data-disabled={String(!repo || !status?.branch)}
              title={repo && status?.branch ? undefined : "请选择已有提交且支持 Worktree 的本机 Git Workspace"}
              onClick={pickWorktreeMode}
            >
              <span className="qwt-glyph"><IconBranch /></span>
              <span>Worktree 模式</span>
              {(inWorktree || pending) && <span className="qwt-check"><IconCheck /></span>}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

// 顶行分支 chip:点击弹出分支选择器(本地/远程/拉取更新)。
function BranchChip(props: {
  api: ReturnType<typeof createApi>
  open: OpenActions
  status?: Status
  cwd?: string
}) {
  const { api, open, status, cwd } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchorStyle, setAnchorStyle] = useState<{ left: number, top: number, transform?: string } | undefined>(undefined)
  const chipRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useAnchorDismiss(menuOpen, chipRef, menuRef, () => setMenuOpen(false))
  useEffect(() => {
    if (!menuOpen) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [menuOpen])

  function openMenu() {
    if (chipRef.current) {
      const rect = chipRef.current.getBoundingClientRect()
      const left = Math.min(rect.left, Math.max(8, window.innerWidth - 300))
      // 与宿主工作区下拉一致,默认贴在 chip 下方;底部放不下且上方有空间时才向上翻。
      const flip = rect.bottom + 324 > window.innerHeight && rect.top > window.innerHeight - rect.bottom
      setAnchorStyle(flip
        ? { left, top: rect.top - 4, transform: "translateY(-100%)" }
        : { left, top: rect.bottom + 4, transform: "none" })
    }
    setMenuOpen(true)
  }

  if (!status?.branch) return null

  return (
    <div ref={chipRef} className="qwt-chip" data-open={String(menuOpen)} onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}>
      <span className="qwt-glyph"><IconBranch /></span>
      <span>{status.branch}</span>
      <span className="qwt-caret"><IconChevron /></span>
      {menuOpen && anchorStyle && createPortal(
        <div
          ref={menuRef}
          className="qwt-menu"
          style={anchorStyle}
          onClick={(event) => event.stopPropagation()}
        >
          <BranchMenu
            api={api}
            open={open}
            status={status}
            cwd={cwd}
            onClose={() => setMenuOpen(false)}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}

// 新会话(hero 顶行):模式 chip + 分支 chip 并排。
function HeroBar(props: {
  api: ReturnType<typeof createApi>
  open: OpenActions
  sessionId?: string
  useSessions: (selector: (state: any) => unknown) => unknown
}) {
  const { api, open, sessionId, useSessions } = props
  const cwd = useSessions((state: any) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)) as string | undefined
  const status = useWorktreeStatus(api, cwd)
  if (sessionId === undefined) return null
  return (
    <div className="qwt-pair">
      <ModeChip api={api} open={open} status={status} cwd={cwd} />
      <BranchChip api={api} open={open} status={status} cwd={cwd} />
    </div>
  )
}

// 会话中(输入行):只读显示,保留 hover 背景;新会话草稿态由顶行负责,这里不出。
// 同时负责「发送时才建 worktree」:标记了 Worktree 模式后,草稿发送(草稿态翻转为真实会话)即创建并跳转。
function SessionBar(props: {
  api: ReturnType<typeof createApi>
  open: OpenActions
  sessionId?: string
  useSessions: (selector: (state: any) => unknown) => unknown
}) {
  const { api, open, sessionId, useSessions } = props
  const cwd = useSessions((state: any) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)) as string | undefined
  const draft = useSessions((state: any) => (sessionId === undefined ? undefined : state.byId[sessionId]?.blank)) as boolean | undefined
  const status = useWorktreeStatus(api, cwd)
  const wasDraftRef = useRef(false)

  useEffect(() => {
    if (draft === true) {
      wasDraftRef.current = true
      return
    }
    if (draft !== false || !wasDraftRef.current) return
    wasDraftRef.current = false
    const target = pendingWorktree.cwd
    if (!target) return
    pendingWorktree.cwd = undefined
    const branch = status?.branch
    if (!branch || !samePath(target, cwd)) return
    void (async () => {
      try {
        const created = await api.branch(target, branch)
        const workspace = await open.workspacesCreate(created.path)
        await open.openWorkspace(workspace.workspaceId)
      } catch { /* 创建失败则留在当前工作区 */ }
    })()
  }, [draft, cwd, status, api, open])

  if (sessionId === undefined || draft === true) return null
  const repo = status?.repo === true
  const worktree = status?.worktrees.find((item) => !item.main && samePath(item.path, cwd))
  const label = worktree
    ? basename(worktree.path)
    : repo && status?.branch ? status.branch : "本地模式"
  return (
    <div className="qwt-chip qwt-static">
      <span className="qwt-glyph">{repo && (worktree || status?.branch) ? <IconBranch /> : <IconLocal />}</span>
      <span>{label}</span>
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
        id: "qoder-worktree-hero",
        order: 10,
        label: "Qoder worktree",
      },
      (props: any) => (
        <HeroBar
          api={api}
          open={open}
          sessionId={props.sessionId}
          useSessions={props.useSessions}
        />
      ),
    ))

    ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
      {
        name: "conversation.input.left",
        id: "qoder-worktree",
        order: 10,
        label: "Qoder worktree",
      },
      (props: any) => (
        <SessionBar
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
