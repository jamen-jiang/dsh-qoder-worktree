# dsh-qoder-worktree

Qoder-style workspace mode & branch chips for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

在 DSH 会话行显示 Qoder 风格的「工作区模式 / 当前分支」chip，按任务创建独立 git worktree。

## What it does / 功能

- **Hero row chips** — on the new-session hero, a mode chip (本地模式 / Worktree 模式) and a branch chip sit next to the workspace and agent-preset pickers. Inside a conversation the same chips render read-only in the composer row.
  新会话顶行显示模式 chip 与分支 chip；会话进行中在输入行显示只读 chip。
- **Branch picker** — the branch chip opens a menu styled after the host's model picker: search box, *local file state* group (current branch + dirty flag), *local branches* and *remote branches* groups, and a *pull* action.
  分支 chip 打开宿主模型下拉风格的菜单：搜索、本地文件状态、本地/远程分支、拉取更新。
- **Arm on select, land on send** — switching mode or picking a branch only records the intent in `~/.dsh/qoder-worktree/arms.json`. At the moment you press send, the plugin creates the task space under `~/.dsh/Worktrees/<repo>/<branch>-<random>` and then switches **the same session in place**: no new session, no message move, sidebar grouping untouched. Windows sandbox writes are gated by a capability SID derived from the session's workspace root; the plugin computes the same SID and grants it Modify on the task-space directory (one `Set-Acl`), so the sandbox immediately allows writes there. The main checkout therefore stays writable by this session — the isolation is convention (the branch chip / task-space directory) rather than OS-enforced; pair it with your own discipline or the plugin's main-tree write guard. Any failure — worktree or ACL — reports the reason, changes nothing, and the message runs in the session as before. New sessions start in 本地模式 by default; Worktree 模式 must be armed explicitly per session.
  选择只挂起意图；点发送那一刻先建任务空间，再把**当前会话原地**切过去：不新建会话、不搬消息、侧栏分组不变。Windows 沙箱写入由一个从工作区根派生的能力 SID 把关，插件算出同一个 SID 给任务空间目录补一条 Modify ACE（一次 Set-Acl），沙箱立即放行。代价是主树对会话仍然可写——隔离是"约定"不是 OS 强制。「本地模式」回主树同样是原地切换。任一步异常 = 报错、什么都不改，消息照常执行。**新会话默认就是「本地模式」**，想进任务空间必须在顶行手动选一次 Worktree 模式（按会话各自记忆，互不影响）。
- **Remote branches** get a tracking local branch (`--track -b`); a branch already checked out in another worktree is added `--detach` with a short-sha suffix, mirroring Qoder's `master-7a450602` naming.
  远程分支自动建跟踪分支;已被占用的分支以 detached + 短 sha 后缀方式添加。

## Install / 安装

```sh
dsh plugin add jamen-jiang/dsh-qoder-worktree
```

Or from npm: `dsh-qoder-worktree` (prebuilt, skips the build-approval step).

## Requirements

- A git repository with at least one commit as the session workspace (non-git workspaces show 本地模式 only).
- Windows host with PowerShell (the ACL grant); Node ≥ 22.19 (host side), DSH harness with the `slots` / `connection` client injects.

## Screenshots

![Hero row with mode and branch chips](assets/screenshot-1.jpg)
![Branch picker menu](assets/screenshot-2.jpg)

## License

MIT
