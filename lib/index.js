// src/host/index.js
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
var API_PREFIX = "/api/dsh-qoder-worktree";
var ENDPOINTS = ["status", "create", "remove", "branches", "fetch", "branch"];
var BRANCH_PREFIX = "qwt";
var ok = (value) => ({ ok: true, value });
var fail = (message) => ({ ok: false, message });
function readClientRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { type, rpcId, method, payload } = body;
  if (type !== "client-request") return null;
  if (typeof rpcId !== "string" || rpcId === "") return null;
  if (typeof method !== "string" || method === "") return null;
  const carried = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return { type, rpcId, method, payload: carried };
}
function canonical(value) {
  const path = resolve(String(value));
  return process.platform === "win32" ? path.toLowerCase() : path;
}
function git(cwd, args, timeoutMs = 1e4) {
  return new Promise((resolvePromise) => {
    execFile("git", args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) resolvePromise({ ok: false, message: String(stderr || error.message || "git failed").trim() });
      else resolvePromise({ ok: true, stdout: String(stdout).trim() });
    });
  });
}
function parseWorktrees(porcelain) {
  const list = [];
  let current = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      if (current !== null) list.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), branch: void 0, main: false, bare: false };
    } else if (current !== null && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    } else if (current !== null && line === "bare") {
      current.bare = true;
    } else if (current !== null && line === "detached") {
      current.detached = true;
    }
  }
  if (current !== null) list.push(current);
  const main = list.find((entry) => !entry.bare);
  if (main !== void 0) main.main = true;
  return list;
}
async function repoStatus(cwd) {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return { repo: false, branch: void 0, commits: 0, worktrees: [], mainToplevel: void 0 };
  }
  const toplevel = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const mainToplevel = toplevel.ok ? toplevel.stdout : void 0;
  const branchHead = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const branch = branchHead.ok && branchHead.stdout ? branchHead.stdout : (await git(cwd, ["rev-parse", "--short", "HEAD"])).stdout || void 0;
  const count = await git(cwd, ["rev-list", "--count", "HEAD"]);
  const commits = count.ok ? Number(count.stdout) || 0 : 0;
  const list = await git(cwd, ["worktree", "list", "--porcelain"]);
  const worktrees = list.ok ? parseWorktrees(list.stdout) : [];
  const porcelain = await git(cwd, ["status", "--porcelain"]);
  const changes = porcelain.ok ? porcelain.stdout.split("\n").filter((line) => line.trim()).length : 0;
  return { repo: true, branch, commits, changes, worktrees, mainToplevel };
}
async function createWorktree(cwd, name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(name)) {
    throw new Error("\u4EFB\u52A1\u7A7A\u95F4\u540D\u79F0\u53EA\u80FD\u5305\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u548C\u4E2D\u5212\u7EBF\uFF0C\u957F\u5EA6 1-40\u3002");
  }
  const status = await repoStatus(cwd);
  if (!status.repo || !status.mainToplevel) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  if (status.commits <= 0) throw new Error("\u4ED3\u5E93\u8FD8\u6CA1\u6709\u63D0\u4EA4\uFF0C\u65E0\u6CD5\u521B\u5EFA Worktree\u3002");
  const repoName = basename(status.mainToplevel);
  const worktreePath = join(homedir(), ".dsh", "Worktrees", repoName, name);
  if (existsSync(worktreePath)) throw new Error(`\u76EE\u5F55\u5DF2\u5B58\u5728\uFF1A${worktreePath}`);
  const branch = `${BRANCH_PREFIX}/${name}`;
  const branchExists = await git(status.mainToplevel, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const args = branchExists.ok ? ["worktree", "add", worktreePath, branch] : ["worktree", "add", "-b", branch, worktreePath];
  const added = await git(status.mainToplevel, args, 6e4);
  if (!added.ok) throw new Error(added.message);
  return { path: worktreePath, branch, name };
}
async function removeWorktree(cwd, target) {
  if (typeof target !== "string" || !isAbsolute(target)) throw new Error("\u9700\u8981 worktree \u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002");
  const status = await repoStatus(cwd);
  if (!status.repo) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  const entry = status.worktrees.find((item) => canonical(item.path) === canonical(target));
  if (entry === void 0) throw new Error("\u8BE5\u76EE\u5F55\u4E0D\u662F\u8FD9\u4E2A\u4ED3\u5E93\u7684 worktree\u3002");
  if (entry.main) throw new Error("\u4E3B\u5DE5\u4F5C\u6811\u4E0D\u80FD\u901A\u8FC7\u8FD9\u91CC\u79FB\u9664\u3002");
  const removed = await git(status.mainToplevel, ["worktree", "remove", entry.path], 6e4);
  if (!removed.ok) throw new Error(removed.message);
  return { path: entry.path };
}
async function listBranches(cwd) {
  const status = await repoStatus(cwd);
  if (!status.repo || !status.mainToplevel) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  const local = await git(status.mainToplevel, ["for-each-ref", "refs/heads", "--format=%(refname:lstrip=2)"]);
  const remote = await git(status.mainToplevel, ["for-each-ref", "refs/remotes", "--format=%(refname:lstrip=2)"]);
  const split = (out) => out.ok && out.stdout ? out.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  return {
    local: split(local),
    remote: split(remote).filter((ref) => !ref.endsWith("/HEAD")),
    current: status.branch,
    worktrees: status.worktrees,
    mainToplevel: status.mainToplevel
  };
}
async function fetchBranches(cwd) {
  const status = await repoStatus(cwd);
  if (!status.repo || !status.mainToplevel) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  const fetched = await git(status.mainToplevel, ["fetch", "--all", "--prune"], 12e4);
  if (!fetched.ok) throw new Error(fetched.message);
  return { fetched: true };
}
async function createWorktreeFromBranch(cwd, ref) {
  if (typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    throw new Error("\u5206\u652F\u540D\u4E0D\u5408\u6CD5\u3002");
  }
  const status = await repoStatus(cwd);
  if (!status.repo || !status.mainToplevel) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  if (status.commits <= 0) throw new Error("\u4ED3\u5E93\u8FD8\u6CA1\u6709\u63D0\u4EA4\uFF0C\u65E0\u6CD5\u521B\u5EFA Worktree\u3002");
  const localExists = await git(status.mainToplevel, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`]);
  const detached = localExists.ok && status.branch === ref;
  let dirName = (localExists.ok ? ref : ref.replace(/^[^/]+\//, "")).split("/").join("-");
  if (detached) {
    const sha = await git(status.mainToplevel, ["rev-parse", "--short", "HEAD"]);
    if (sha.ok && sha.stdout) dirName = `${dirName}-${sha.stdout}`;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(dirName)) throw new Error(`\u65E0\u6CD5\u4ECE\u5206\u652F\u6D3E\u751F\u4EFB\u52A1\u7A7A\u95F4\u540D\u79F0\uFF1A${ref}`);
  const repoName = basename(status.mainToplevel);
  const worktreePath = join(homedir(), ".dsh", "Worktrees", repoName, dirName);
  const shortName = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
  if (existsSync(worktreePath)) {
    return { path: worktreePath, branch: detached ? void 0 : localExists.ok ? ref : shortName, name: dirName };
  }
  const args = localExists.ok ? detached ? ["worktree", "add", worktreePath, "--detach", ref] : ["worktree", "add", worktreePath, ref] : ["worktree", "add", worktreePath, "--track", "-b", shortName, ref];
  const added = await git(status.mainToplevel, args, 6e4);
  if (!added.ok) throw new Error(added.message);
  return { path: worktreePath, branch: detached ? void 0 : localExists.ok ? ref : shortName, name: dirName };
}
async function handle(endpoint, payload) {
  if (endpoint === "status") return ok(await repoStatus(String(payload.cwd ?? "")));
  if (endpoint === "create") return ok(await createWorktree(String(payload.cwd ?? ""), payload.name));
  if (endpoint === "remove") return ok(await removeWorktree(String(payload.cwd ?? ""), payload.path));
  if (endpoint === "branches") return ok(await listBranches(String(payload.cwd ?? "")));
  if (endpoint === "fetch") return ok(await fetchBranches(String(payload.cwd ?? "")));
  if (endpoint === "branch") return ok(await createWorktreeFromBranch(String(payload.cwd ?? ""), payload.ref));
  return fail(`Unknown endpoint: ${endpoint}`);
}
var inject = ["connection"];
function apply(ctx) {
  for (const endpoint of ENDPOINTS) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `${API_PREFIX}/${endpoint}`,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/json") {
          return new Response("content type must be application/json", { status: 415 });
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response("body is not JSON", { status: 400 });
        }
        const message = readClientRequest(body);
        if (message === null) return new Response("invalid client-request message", { status: 400 });
        const result = message.method === `dsh-qoder-worktree/${endpoint}` ? await handle(endpoint, message.payload).catch((error) => fail(String(error?.message ?? error))) : fail("RPC method does not match endpoint.");
        return Response.json({ type: "server-response", rpcId: message.rpcId, result });
      }
    }), `dsh-qoder-worktree ${endpoint} route`);
  }
}
export {
  apply,
  inject
};
