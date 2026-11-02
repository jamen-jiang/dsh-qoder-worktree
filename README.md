# dsh-qoder-worktree

Qoder-style workspace mode & branch chips for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

在 DSH 会话行显示 Qoder 风格的「工作区模式 / 当前分支」chip，按任务创建独立 git worktree。

## What it does / 功能

- **Hero row chips** — on the new-session hero, a mode chip (本地模式 / Worktree 模式) and a branch chip sit next to the workspace and agent-preset pickers. Inside a conversation the same chips render read-only in the composer row.
  新会话顶行显示模式 chip 与分支 chip；会话进行中在输入行显示只读 chip。
- **Branch picker** — the branch chip opens a menu styled after the host's model picker: search box, *local file state* group (current branch + dirty flag), *local branches* and *remote branches* groups, and a *pull* action.
  分支 chip 打开宿主模型下拉风格的菜单：搜索、本地文件状态、本地/远程分支、拉取更新。
- **Arm on select, land on send** — switching mode or picking a branch only records the intent in `~/.dsh/qoder-worktree/arms.json`. When the first message of the session is inserted, the plugin creates a dedicated git worktree under `~/.dsh/Worktrees/<repo>/<branch>[-<short-sha>]` and moves the session's effective working directory in place via a `working-directory/change` projection — no extra workspaces pile up in the sidebar.
  选择只挂起意图，发送第一条消息时才真正建 worktree 并原地迁移会话目录，侧栏不再堆积工作区。
- **Remote branches** get a tracking local branch (`--track -b`); a branch already checked out in another worktree is added `--detach` with a short-sha suffix, mirroring Qoder's `master-7a450602` naming.
  远程分支自动建跟踪分支;已被占用的分支以 detached + 短 sha 后缀方式添加。

## Install / 安装

```sh
dsh plugin add jamen-jiang/dsh-qoder-worktree
```

Or from npm: `dsh-qoder-worktree` (prebuilt, skips the build-approval step).

## Requirements

- A git repository with at least one commit as the session workspace (non-git workspaces show 本地模式 only).
- Node ≥ 22.19 (host side), DSH harness with the `slots` / `connection` / `workspaces` / `uiWorkspace` / `sessions` client injects.

## Screenshots

![Hero row with mode and branch chips](assets/screenshot-1.jpg)
![Branch picker menu](assets/screenshot-2.jpg)

## License

MIT
