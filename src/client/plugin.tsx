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
    arm: (sessionId: string, payload: { cwd: string, mode: "local" | "worktree", ref?: string, newBranch?: string, carry?: boolean }) =>
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
  // Qoder CN 原版 QoderGitBranchChangesLine(反编译自其 renderer bundle),三 evenodd 路径:
  // 左主干串两节点+引线、右上小节点带短茎、右下大圆内六芒雪花镂空。
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M5.99997 2.99949C6.70792 2.99949 7.39309 3.2498 7.93435 3.70613C8.4756 4.16245 8.8381 4.79543 8.95778 5.49319C9.07746 6.19095 8.94661 6.90856 8.58835 7.51916C8.23008 8.12977 7.66746 8.5941 6.99997 8.83V12C7.83597 11.372 8.87398 11 9.99997 11H12.8536C12.1677 11.5442 11.5947 12.2244 11.1754 13H9.99997C9.34187 13 8.70198 13.2163 8.17888 13.6156C7.65578 14.0149 7.27846 14.5752 7.105 15.21C7.75864 15.4691 8.30054 15.9495 8.63615 16.5674C8.97177 17.1852 9.07978 17.9013 8.94133 18.5907C8.80288 19.2801 8.42678 19.899 7.87863 20.3393C7.33048 20.7797 6.64507 21.0136 5.94206 21.0003C5.23906 20.9869 4.56307 20.7271 4.03205 20.2662C3.50102 19.8054 3.14871 19.1726 3.03654 18.4785C2.92439 17.7844 3.05949 17.0729 3.41833 16.4682C3.77717 15.8636 4.33695 15.4041 4.99997 15.17V8.83C4.33248 8.5941 3.7699 8.12977 3.41164 7.51916C3.05338 6.90856 2.92248 6.19095 3.04216 5.49319C3.16183 4.79543 3.52435 4.16245 4.0656 3.70613C4.60685 3.2498 5.29202 2.99949 5.99997 2.99949ZM5.99997 17C5.73476 17 5.48042 17.1054 5.29289 17.2929C5.10536 17.4804 4.99998 17.7348 4.99997 18C4.99997 18.2652 5.10535 18.5196 5.29289 18.7071C5.48042 18.8946 5.73476 19 5.99997 19C6.26519 19 6.51956 18.8946 6.7071 18.7071C6.89463 18.5196 6.99997 18.2652 6.99997 18C6.99997 17.7348 6.89463 17.4804 6.7071 17.2929C6.51956 17.1054 6.26519 17 5.99997 17ZM5.99997 4.99997C5.73476 4.99998 5.48042 5.10536 5.29289 5.29289C5.10536 5.48043 4.99997 5.73476 4.99997 5.99997C4.99997 6.26519 5.10535 6.51957 5.29289 6.7071C5.48042 6.89463 5.73476 6.99997 5.99997 6.99997C6.26519 6.99997 6.51956 6.89464 6.7071 6.7071C6.89463 6.51957 6.99997 6.26519 6.99997 5.99997C6.99997 5.73477 6.89463 5.48043 6.7071 5.29289C6.51956 5.10536 6.26519 4.99997 5.99997 4.99997Z" />
      <path fillRule="evenodd" d="M18.0944 3.00027C18.8005 3.02251 19.4761 3.29316 20.0023 3.76453C20.5285 4.23589 20.8715 4.87777 20.971 5.57717C21.0705 6.27658 20.92 6.98866 20.5461 7.58806C20.1722 8.18746 19.5989 8.63573 18.927 8.85398C18.8677 9.19546 18.7735 9.52753 18.6471 9.84553C18.0839 9.68562 17.4894 9.60002 16.875 9.60002C16.7601 9.60002 16.6459 9.60305 16.5325 9.60896C16.6925 9.35725 16.8153 9.08155 16.895 8.79001C16.2382 8.52992 15.6941 8.04642 15.3587 7.42468C15.0233 6.80295 14.9179 6.0828 15.0612 5.39104C15.2045 4.69929 15.5873 4.08026 16.1421 3.64294C16.6969 3.20562 17.3883 2.97803 18.0944 3.00027ZM18 4.99997C17.7348 4.99998 17.4804 5.10536 17.2929 5.29289C17.1054 5.48043 17 5.73476 17 5.99997C17 6.26519 17.1054 6.51957 17.2929 6.7071C17.4804 6.89463 17.7348 6.99997 18 6.99997C18.2652 6.99997 18.5196 6.89464 18.7071 6.7071C18.8946 6.51957 19 6.26519 19 5.99997C19 5.73477 18.8946 5.48043 18.7071 5.29289C18.5196 5.10536 18.2652 4.99997 18 4.99997Z" />
      <path fillRule="evenodd" d="M16.875 10.9C19.7331 10.9 22.05 13.2169 22.05 16.075C22.05 18.9331 19.7331 21.25 16.875 21.25C14.0169 21.25 11.7 18.9331 11.7 16.075C11.7 13.2169 14.0169 10.9 16.875 10.9ZM16 12.5875V14.5339L14.3253 13.567L13.4253 15.1259L15.1124 16.1L13.425 17.0742L14.325 18.6331L16 17.666V19.6375H17.8V17.6516L19.4999 18.6331L20.3999 17.0742L18.7125 16.1L20.3997 15.1259L19.4997 13.567L17.8 14.5483V12.5875H16Z" />
    </svg>
  )
}

function IconWorktree() {
  // Qoder 同款:左主干串两节点,中段引线接右下加号大圆,右上小节点带短茎。
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <line x1="6" y1="7.2" x2="6" y2="16.8" />
      <path d="M6 12.5h3c2 0 2.8 2.2 4 3.5" />
      <circle cx="17" cy="6" r="1.8" />
      <path d="M17 8v2.4" />
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

  async function arm(mode: "local" | "worktree", extra?: { ref?: string, carry?: boolean }) {
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
    // 默认等同分支菜单的「本地文件状态」:当前分支 + 把未提交改动一起带进任务空间(carry)。
    void arm("worktree", { ref: status.branch, carry: true })
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
      title={cwd}
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
    <div className="qwt-chip qwt-static" title={cwd}>
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
