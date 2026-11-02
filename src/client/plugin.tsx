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
  // 会话的生效目录(Host 按 working-directory 投影/登记表算);undefined = 从未切换过(= 工作区根)。
  workingPath?: string
  // 待发送意图:切了模式/选了分支但还没发消息,Host 在首条消息进 inbox 时才建 worktree 并切目录。
  arm?: { mode: "local" | "worktree", ref?: string, newBranch?: string, carry?: boolean, error?: string } | null
  // 当前生效目录当初是不是"带未提交改动"开的任务空间(Host spaces.json 档案)。
  carryWorking?: boolean
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
    status: (cwd: string, sessionId?: string) => call("status", { cwd, sessionId: sessionId ?? "" }) as Promise<Status>,
    branches: (cwd: string) => call("branches", { cwd }) as Promise<Branches>,
    fetch: (cwd: string) => call("fetch", { cwd }),
    branch: (cwd: string, ref: string) => call("branch", { cwd, ref }),
    newBranch: (cwd: string, name: string) => call("new-branch", { cwd, name }),
    create: (cwd: string, name: string) => call("create", { cwd, name }),
    remove: (cwd: string, path: string) => call("remove", { cwd, path }),
    // 当前会话原地指向 path(worktree/主树):不建工作区、不切会话,草稿留在输入框里。
    use: (sessionId: string, path: string) => call("use", { sessionId, path }),
    // 登记待发送意图:切模式/选分支只 arm,Host 在首条消息进 inbox 时才建 worktree 并切目录。
    arm: (sessionId: string, payload: { cwd: string, mode: "local" | "worktree", ref?: string, newBranch?: string }) =>
      call("arm", { sessionId, ...payload }),
    armCancel: (sessionId: string) => call("arm-cancel", { sessionId }),
  }
}

function samePath(a?: string, b?: string) {
  if (!a || !b) return false
  const norm = (value: string) => value.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()
  // 浏览器客户端没有 process,用路径本身识别 Windows(盘符或反斜杠)。
  const windows = /^[A-Za-z]:[\\/]/.test(a) || /^[A-Za-z]:[\\/]/.test(b)
  return windows ? norm(a) === norm(b) : a === b
}

/** 会话生效目录:workingPath 优先(可能已指向别的 worktree),没切过就是工作区根。 */
function effectiveDir(status: Status | undefined, cwd?: string) {
  return status?.workingPath ?? cwd
}

/** 生效目录命中的非主 worktree 条目;本地模式为 undefined。 */
function worktreeOf(status: Status | undefined, cwd?: string) {
  const dir = effectiveDir(status, cwd)
  if (!dir) return undefined
  return status?.worktrees.find((item) => !item.main && samePath(item.path, dir))
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

function IconWorktree() {
  // 主树 + 派生工作树:左侧一条分支线串两个节点,右侧小节点 + 齿轮节点。
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <line x1="6" y1="7.2" x2="6" y2="16.8" />
      <circle cx="17" cy="6" r="1.8" />
      <circle cx="17" cy="16.5" r="4.2" />
      <line x1="17" y1="14.1" x2="17" y2="18.9" />
      <line x1="14.6" y1="16.5" x2="19.4" y2="16.5" />
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

// 分支列表也缓存:宿主 listBranches 要跑好几个 git 子进程,菜单打开时现拉会先空后有。
// chip 挂载/悬停就预取,菜单先画缓存再后台刷新。
const branchesCache = new Map<string, Branches>()
const branchesInflight = new Map<string, Promise<Branches>>()

function loadBranches(api: ReturnType<typeof createApi>, cwd: string | undefined, force = false) {
  if (!cwd) return undefined
  const cached = branchesCache.get(cwd)
  if (cached && !force) return Promise.resolve(cached)
  const running = branchesInflight.get(cwd)
  if (running) return running
  const request = api.branches(cwd).then((next) => {
    branchesCache.set(cwd, next)
    branchesInflight.delete(cwd)
    return next
  }, (error: unknown) => {
    branchesInflight.delete(cwd)
    throw error
  })
  branchesInflight.set(cwd, request)
  return request
}

function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function basename(path?: string) {
  if (!path) return ""
  const trimmed = path.replace(/[\\/]+$/, "")
  const at = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

function BranchMenu(props: {
  api: ReturnType<typeof createApi>
  sessionId?: string
  status?: Status
  cwd?: string
  onArm: () => void
  onClose: () => void
}) {
  const { api, sessionId, status, cwd, onArm, onClose } = props
  const [query, setQuery] = useState("")
  const [branches, setBranches] = useState<Branches | undefined>(() => (cwd ? branchesCache.get(cwd) : undefined))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const searchRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const newRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    if (creating) newRef.current?.focus()
  }, [creating])

  useEffect(() => {
    if (!cwd) return undefined
    let alive = true
    // 缓存先画,后台强刷一次覆盖。
    const cached = branchesCache.get(cwd)
    if (cached) setBranches(cached)
    loadBranches(api, cwd, true)
      ?.then((next) => { if (alive) setBranches(next) })
      .catch(() => { /* 菜单保持已加载内容 */ })
    return () => { alive = false }
  }, [api, cwd])

  const repo = status?.repo === true
  const inWorktree = worktreeOf(status, cwd) !== undefined
  // 乐观模式:arm 登记了意图但还没落地(未发消息)时,芯片按 arm 显示。
  const armed = status?.arm?.mode
  const worktreeMode = armed === "worktree" ? true : armed === "local" ? false : inWorktree
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

  async function arm(mode: "local" | "worktree", extra?: { ref?: string, newBranch?: string, carry?: boolean }) {
    if (!cwd || !sessionId || busy) return
    setError(undefined)
    setBusy(true)
    try {
      await api.arm(sessionId, { cwd, mode, ...extra })
      onArm()
      onClose()
    } catch (cause) {
      setError(String((cause as Error).message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  // 「本地文件状态」= 把当前未提交的改动一起带进任务空间;选普通分支则是干净检出(不含未提交改动)。
  // 目录名是随机后缀,认不出来源,勾选取 Host 的任务空间档案(carryWorking)。
  const localSelected = status?.arm?.carry === true || status?.carryWorking === true
  function pickLocalState() {
    if (status?.branch === undefined) return void onClose()
    return arm("worktree", { ref: status.branch, carry: true })
  }

  async function pickBranch(ref: string) {
    if (busy) return
    // 生效目录就在该分支上且没有 arm 意图:已经是它了。
    if (ref === status?.branch && status?.arm == null) return void onClose()
    await arm("worktree", { ref })
  }

  // 「新建分支」:只登记意图,Host 在首条消息进 inbox 时才建分支 + Worktree 并切入。
  async function submitNewBranch() {
    if (!newName.trim()) return
    await arm("worktree", { newBranch: newName.trim() })
    setCreating(false)
    setNewName("")
  }

  return (
    <>
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
          {needle === "" && worktreeMode && (
            <section className="qwt-group">
              <span className="qwt-groupStart" aria-hidden="true" />
              <div className="qwt-groupHeading" data-qwt-heading title="把当前未提交的改动一起带进任务空间">本地文件状态</div>
              <div
                className="qwt-item"
                title={status?.mainToplevel}
                onClick={() => void pickLocalState()}
              >
                <span className="qwt-glyph"><IconWorktree /></span>
                <span>{status?.branch}</span>
                <span className="qwt-sub">{(status?.changes ?? 0) > 0 ? `${status?.changes} 个未提交改动` : "无未提交改动"}</span>
                {localSelected && <span className="qwt-check"><IconCheck /></span>}
              </div>
            </section>
          )}
          <section className="qwt-group">
            <span className="qwt-groupStart" aria-hidden="true" />
            <div className="qwt-groupHeading" data-qwt-heading title="仓库里已提交历史的分支">本地分支</div>
            {locals.map((name) => {
              // 勾了「本地文件状态」时不再勾分支行:两者是互斥的两种任务空间来源。
              const checked = name === status?.branch && !localSelected
              return (
              <div
                key={name}
                className="qwt-item"
                data-active={String(checked)}
                title={name}
                onClick={() => void pickBranch(name)}
              >
                <span className="qwt-glyph"><IconBranch /></span>
                <span>{name}</span>
                {checked && <span className="qwt-check"><IconCheck /></span>}
              </div>
              )
            })}
            {locals.length === 0 && <div className="qwt-empty">没有匹配的本地分支</div>}
          </section>
        </div>
      )}
      {!worktreeMode && (
      <div className="qwt-new">
        {creating ? (
          <input
            ref={newRef}
            className="qwt-newInput"
            placeholder="新分支名称，Enter 创建"
            value={newName}
            disabled={busy}
            spellCheck={false}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter") void submitNewBranch()
              if (event.key === "Escape") {
                setCreating(false)
                setNewName("")
                setError(undefined)
                searchRef.current?.focus()
              }
            }}
          />
        ) : (
          <div className="qwt-item" title="从当前 HEAD 创建新分支并在新 Worktree 打开" onClick={() => { setError(undefined); setCreating(true) }}>
            <span className="qwt-glyph"><IconPlus /></span>
            <span>新建分支</span>
          </div>
        )}
      </div>
      )}
      {error ?? status?.arm?.error ? <div className="qwt-error">{error ?? status?.arm?.error}</div> : null}
    </>
  )
}

// 切换会话时插槽会重挂,若等 RPC 回来才渲染,芯片要空 ~0.5s 才蹦出来。
// 两级缓存:byKey 带会话(有 arm/生效目录这类会话态),byCwd 只按目录——同仓库的
// 每个新会话第一次也能拿 byCwd 立刻画分支,后台再用 byKey 的精确结果覆盖。
const statusByKey = new Map<string, Status>()
const statusByCwd = new Map<string, Status>()
const statusKey = (cwd: string | undefined, sessionId: string | undefined) => `${sessionId ?? ""}|${cwd ?? ""}`

function useWorktreeStatus(api: ReturnType<typeof createApi>, cwd: string | undefined, sessionId: string | undefined, nonce: number) {
  const [status, setStatus] = useState<Status | undefined>(() =>
    cwd === undefined ? undefined : statusByKey.get(statusKey(cwd, sessionId)) ?? statusByCwd.get(cwd))
  useEffect(() => {
    // 换会话/换目录:先显示缓存(没有就清空),不等网络。
    setStatus(cwd === undefined ? undefined : statusByKey.get(statusKey(cwd, sessionId)) ?? statusByCwd.get(cwd))
    if (!cwd) return undefined
    let alive = true
    const poll = async () => {
      try {
        const next = await api.status(cwd, sessionId)
        statusByKey.set(statusKey(cwd, sessionId), next)
        // 会话态字段不进目录级缓存,免得串到别的会话。
        const { arm: _arm, workingPath: _wp, ...shared } = next
        statusByCwd.set(cwd, shared as Status)
        if (alive) setStatus(next)
      } catch { /* the next tick retries */ }
    }
    void poll()
    const timer = setInterval(poll, 8000)
    return () => { alive = false; clearInterval(timer) }
  }, [api, cwd, sessionId, nonce])
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

// 顶行(新会话)模式 chip:菜单只有「本地模式 / Worktree 模式」两项。选择只登记待发送意图(arm),
// Host 在该会话首条消息进 inbox 时才建 worktree 并把会话生效目录原地切过去——不建工作区、不切会话。
function ModeChip(props: {
  api: ReturnType<typeof createApi>
  sessionId?: string
  status?: Status
  cwd?: string
  onArm: () => void
}) {
  const { api, sessionId, status, cwd, onArm } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchorStyle, setAnchorStyle] = useState<{ left: number, top: number, transform?: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
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
  const inWorktree = worktreeOf(status, cwd) !== undefined
  const armed = status?.arm?.mode
  const worktreeMode = armed === "worktree" ? true : armed === "local" ? false : inWorktree

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
    if (!menuOpen) {
      setError(undefined)
      anchorBelow()
    }
    setMenuOpen((value) => !value)
  }

  async function arm(mode: "local" | "worktree", extra?: { ref?: string }) {
    if (!cwd || !sessionId || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await api.arm(sessionId, { cwd, mode, ...extra })
      onArm()
      setMenuOpen(false)
    } catch (cause) {
      setError(String((cause as Error).message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  function goLocal() {
    if (worktreeMode) void arm("local")
    else setMenuOpen(false)
  }

  function pickWorktreeMode() {
    if (!repo || worktreeMode || !status?.branch) return
    // 为当前分支建(或复用)worktree——主树占用的分支自动 --detach,目录名 main-<短sha>(Qoder 风格)。
    void arm("worktree", { ref: status.branch })
  }

  return (
    <div ref={chipRef} className="qwt-chip" data-open={String(menuOpen)} onClick={toggle}>
      <span className="qwt-glyph">{worktreeMode ? <IconBranch /> : <IconLocal />}</span>
      <span>{worktreeMode ? "Worktree 模式" : "本地模式"}</span>
      <span className="qwt-caret"><IconChevron /></span>
      {menuOpen && anchorStyle && createPortal(
        <div
          ref={menuRef}
          className="qwt-menu qwt-mode-menu"
          style={anchorStyle}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="qwt-list">
            <div className="qwt-item" data-active={String(!worktreeMode)} onClick={() => void goLocal()}>
              <span className="qwt-glyph"><IconLocal /></span>
              <span>本地模式</span>
              {!worktreeMode && <span className="qwt-check"><IconCheck /></span>}
            </div>
            <div
              className="qwt-item"
              data-active={String(worktreeMode)}
              data-disabled={String(!repo || !status?.branch)}
              title={repo && status?.branch ? undefined : "请选择已有提交且支持 Worktree 的本机 Git Workspace"}
              onClick={() => void pickWorktreeMode()}
            >
              <span className="qwt-glyph"><IconBranch /></span>
              <span>Worktree 模式</span>
              {worktreeMode && <span className="qwt-check"><IconCheck /></span>}
            </div>
          </div>
          {error ?? status?.arm?.error ? <div className="qwt-error">{error ?? status?.arm?.error}</div> : null}
        </div>,
        document.body,
      )}
    </div>
  )
}

// 顶行分支 chip:点击弹出分支选择器;选中分支/新建分支只登记意图,发送时才落地。
function BranchChip(props: {
  api: ReturnType<typeof createApi>
  sessionId?: string
  status?: Status
  cwd?: string
  onArm: () => void
}) {
  const { api, sessionId, status, cwd, onArm } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const [anchorStyle, setAnchorStyle] = useState<{ left: number, top: number, transform?: string } | undefined>(undefined)
  const chipRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // 芯片一出现就把分支列表拉进缓存,点开菜单时先画缓存;悬停再补一次新鲜的。
  useEffect(() => {
    loadBranches(api, cwd)?.catch(() => { /* 点开菜单时还会再试 */ })
  }, [api, cwd])

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

  // 任务空间里显示空间名(main-387e3f22,WorkBuddy 同款:detached 时没有分支名可显示);
  // 主树里显示分支名。有待发送意图时优先显示意图。
  const space = worktreeOf(status, cwd)
  const label = status?.arm?.newBranch ?? status?.arm?.ref ?? (space !== undefined ? basename(space.path) : status?.branch)

  if (!label) return null

  return (
    <div
      ref={chipRef}
      className="qwt-chip"
      data-open={String(menuOpen)}
      onPointerEnter={() => { loadBranches(api, cwd, true)?.catch(() => { /* 菜单里还会再试 */ }) }}
      onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
    >
      <span className="qwt-glyph"><IconBranch /></span>
      <span>{label}</span>
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
            sessionId={sessionId}
            status={status}
            cwd={cwd}
            onArm={onArm}
            onClose={() => setMenuOpen(false)}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}

// 新会话(hero 顶行):模式 chip + 分支 chip 并排;arm 登记后立刻重拉 status 让芯片乐观显示。
function HeroBar(props: {
  api: ReturnType<typeof createApi>
  sessionId?: string
  useSessions: (selector: (state: any) => unknown) => unknown
}) {
  const { api, sessionId, useSessions } = props
  const cwd = useSessions((state: any) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)) as string | undefined
  const [nonce, setNonce] = useState(0)
  const status = useWorktreeStatus(api, cwd, sessionId, nonce)
  const onArm = useCallback(() => setNonce((value) => value + 1), [])
  if (sessionId === undefined) return null
  // 不是 Git 仓库(或还没探出来)就不占顶行位置。
  if (status?.repo !== true) return null
  return (
    <div className="qwt-pair">
      <ModeChip api={api} sessionId={sessionId} status={status} cwd={cwd} onArm={onArm} />
      <BranchChip api={api} sessionId={sessionId} status={status} cwd={cwd} onArm={onArm} />
    </div>
  )
}

// 会话中(输入行):只读显示当前生效位置;新会话草稿态由顶行负责,这里不出。
function SessionBar(props: {
  api: ReturnType<typeof createApi>
  sessionId?: string
  useSessions: (selector: (state: any) => unknown) => unknown
}) {
  const { api, sessionId, useSessions } = props
  const cwd = useSessions((state: any) => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)) as string | undefined
  const draft = useSessions((state: any) => (sessionId === undefined ? undefined : state.byId[sessionId]?.blank)) as boolean | undefined
  const status = useWorktreeStatus(api, cwd, sessionId, 0)

  if (sessionId === undefined || draft === true) return null
  const repo = status?.repo === true
  // 非 Git 工作区不显示这枚芯片。
  if (!repo) return null
  const worktree = worktreeOf(status, cwd)
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
  inject: ["slots", "connection"],
  apply(ctx: ClientContext & Record<string, any>) {
    ctx.effect(installStyles, "dsh-qoder-worktree styles")
    const api = createApi(ctx.connection)

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
          sessionId={props.sessionId}
          useSessions={props.useSessions}
        />
      ),
    ))
  },
}

export default QoderWorktreePlugin
