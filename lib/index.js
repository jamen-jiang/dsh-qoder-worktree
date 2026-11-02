// src/host/index.js
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
var API_PREFIX = "/api/dsh-qoder-worktree";
var ENDPOINTS = ["status", "create", "remove", "branches", "fetch", "branch", "new-branch", "use", "arm", "arm-cancel"];
var BRANCH_PREFIX = "qwt";
var STATE_PATH = join(homedir(), ".dsh", "qoder-worktree", "sessions.json");
var ARMS_PATH = join(homedir(), ".dsh", "qoder-worktree", "arms.json");
var WORKTREES_ROOT = join(homedir(), ".dsh", "Worktrees");
var ok = (value) => ({ ok: true, value });
var fail = (message) => ({ ok: false, message });
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
var ctx;
function readStore() {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
function writeStore(entry) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(entry, null, 2), "utf8");
  } catch {
  }
}
function readArms() {
  try {
    const raw = JSON.parse(readFileSync(ARMS_PATH, "utf8"));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
function writeArms(entry) {
  try {
    mkdirSync(dirname(ARMS_PATH), { recursive: true });
    writeFileSync(ARMS_PATH, JSON.stringify(entry, null, 2), "utf8");
  } catch {
  }
}
var SPACES_PATH = join(homedir(), ".dsh", "qoder-worktree", "spaces.json");
function readSpaces() {
  try {
    const raw = JSON.parse(readFileSync(SPACES_PATH, "utf8"));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}
function writeSpace(path, info) {
  const spaces = readSpaces();
  spaces[canonical(path)] = info;
  try {
    mkdirSync(dirname(SPACES_PATH), { recursive: true });
    writeFileSync(SPACES_PATH, JSON.stringify(spaces, null, 2), "utf8");
  } catch {
  }
}
function forgetSpace(path) {
  const spaces = readSpaces();
  if (spaces[canonical(path)] === void 0) return;
  delete spaces[canonical(path)];
  try {
    writeFileSync(SPACES_PATH, JSON.stringify(spaces, null, 2), "utf8");
  } catch {
  }
}
function sessionWorkingPath(sessionId) {
  if (!sessionId) return void 0;
  const agent = ctx?.agents?.get(sessionId);
  if (agent !== void 0) {
    try {
      const current = ctx.workingDirectory.get(agent.session);
      if (typeof current === "string" && current) return current;
    } catch {
    }
  }
  const stored = readStore();
  return typeof stored[sessionId] === "string" ? stored[sessionId] : void 0;
}
function parseWorktrees(text) {
  const items = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) items.push(current);
      current = { path: line.slice("worktree ".length).trim(), detached: false };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "").trim();
    } else if (current && line.trim() === "detached") {
      current.detached = true;
    }
  }
  if (current) items.push(current);
  return items.map((item, index) => ({ ...item, main: index === 0 }));
}
async function repoStatus(cwd, sessionId) {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") {
    return { repo: false, branch: void 0, commits: 0, worktrees: [], mainToplevel: void 0 };
  }
  const workingPath = sessionWorkingPath(sessionId);
  const dir = workingPath !== void 0 && existsSync(workingPath) ? workingPath : cwd;
  const [toplevel, list, branch, count, porcelain] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["worktree", "list", "--porcelain"]),
    git(dir, ["symbolic-ref", "--short", "HEAD"]),
    git(dir, ["rev-list", "--count", "HEAD"]),
    git(dir, ["status", "--porcelain"])
  ]);
  const worktrees = parseWorktrees(list.ok ? list.stdout : "");
  const mainToplevel = worktrees.find((item) => item.main)?.path ?? (toplevel.ok ? toplevel.stdout : void 0);
  const branchValue = branch.ok ? branch.stdout : void 0;
  const commits = count.ok ? Number(count.stdout) || 0 : 0;
  const changes = porcelain.ok ? porcelain.stdout.split("\n").filter((line) => line.trim()).length : 0;
  const arm = sessionId !== void 0 && sessionId !== "" ? readArms()[sessionId] ?? null : null;
  const carryWorking = readSpaces()[canonical(dir)]?.carry === true;
  return { repo: true, branch: branchValue, commits, changes, worktrees, mainToplevel, workingPath, arm, carryWorking };
}
function dirNameFor(ref) {
  const name = ref.split("/").join("-");
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(name) ? name : void 0;
}
function uid8() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}
function slugifyRef(ref) {
  return (dirNameFor(ref) ?? ref.split("/").join("-")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "worktree";
}
async function createWorktreeFromBranch(cwd, ref, options = {}) {
  const carry = options.carry === true;
  if (typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(ref) || ref.includes("..") || ref.endsWith("/")) {
    throw new Error("\u5206\u652F\u540D\u4E0D\u5408\u6CD5\u3002");
  }
  const status = await repoStatus(cwd);
  if (!status.repo || !status.mainToplevel) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  if (status.commits <= 0) throw new Error("\u4ED3\u5E93\u8FD8\u6CA1\u6709\u63D0\u4EA4\uFF0C\u65E0\u6CD5\u521B\u5EFA Worktree\u3002");
  const sha = await git(status.mainToplevel, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha.ok || !sha.stdout) throw new Error(`\u5206\u652F\u4E0D\u5B58\u5728\uFF1A${ref}`);
  const slug = slugifyRef(ref);
  const repoDir = join(WORKTREES_ROOT, basename(status.mainToplevel));
  let dirName = "";
  let worktreePath = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    dirName = `${slug}-${uid8()}`;
    worktreePath = join(repoDir, dirName);
    if (!existsSync(worktreePath) && !status.worktrees.some((item) => canonical(item.path) === canonical(worktreePath))) break;
    if (attempt === 5) throw new Error("\u4EFB\u52A1\u7A7A\u95F4\u76EE\u5F55\u540D\u8FDE\u7EED\u649E\u8F66\uFF0C\u8BF7\u91CD\u8BD5\u3002");
  }
  mkdirSync(dirname(worktreePath), { recursive: true });
  const added = await addWorktree(status.mainToplevel, worktreePath, ref);
  if (!added.ok) {
    const detached = await addWorktree(status.mainToplevel, worktreePath, ref, true);
    if (!detached.ok) {
      rmSync(worktreePath, { recursive: true, force: true });
      throw new Error(added.message || detached.message);
    }
    if (carry) await carryLocalChanges(options.from ?? cwd, worktreePath);
    writeSpace(worktreePath, { carry, ref, createdAt: Date.now() });
    return { path: worktreePath, branch: void 0, detached: true, name: dirName };
  }
  if (carry) await carryLocalChanges(options.from ?? cwd, worktreePath);
  writeSpace(worktreePath, { carry, ref, createdAt: Date.now() });
  return { path: worktreePath, branch: ref, name: dirName };
}
async function addWorktree(toplevel, path, ref, detach = false) {
  const args = detach ? ["worktree", "add", "--detach", path, ref] : ["worktree", "add", path, ref];
  const first = await git(toplevel, args, 3e5);
  if (first.ok || !/already registered/.test(first.message ?? "")) return first;
  await git(toplevel, ["worktree", "prune"], 3e4);
  return git(toplevel, args, 3e5);
}
async function carryLocalChanges(src, dst) {
  if (!src || !existsSync(src) || canonical(src) === canonical(dst)) return;
  const patch = join(tmpdir(), `qwt-carry-${Date.now().toString(36)}.patch`);
  const diff = await git(src, ["diff", "HEAD", "--binary", `--output=${patch}`], 6e4);
  if (!diff.ok) throw new Error(diff.message);
  try {
    if (existsSync(patch) && statSync(patch).size > 0) {
      const applied = await git(dst, ["apply", "--whitespace=nowarn", patch.replace(/\\/g, "/")], 6e4);
      if (!applied.ok) throw new Error(`\u672A\u63D0\u4EA4\u7684\u6539\u52A8\u642C\u4E0D\u8FC7\u53BB\uFF1A${applied.message}`);
    }
  } finally {
    try {
      if (existsSync(patch)) rmSync(patch);
    } catch {
    }
  }
  const others = await git(src, ["ls-files", "--others", "--exclude-standard", "-z"], 3e4);
  if (!others.ok) return;
  for (const relative of others.stdout.split("\0").filter(Boolean)) {
    const from = join(src, relative);
    const to = join(dst, relative);
    try {
      if (!statSync(from).isFile()) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    } catch {
    }
  }
}
async function createWorktree(cwd, name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/.test(name)) {
    throw new Error("\u4EFB\u52A1\u7A7A\u95F4\u540D\u79F0\u53EA\u80FD\u5305\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u548C\u4E2D\u5212\u7EBF\uFF0C\u957F\u5EA6 1-40\u3002");
  }
  const status = await repoStatus(cwd);
  if (!status.repo || !status.mainToplevel) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  if (status.commits <= 0) throw new Error("\u4ED3\u5E93\u8FD8\u6CA1\u6709\u63D0\u4EA4\uFF0C\u65E0\u6CD5\u521B\u5EFA Worktree\u3002");
  const branch = `${BRANCH_PREFIX}/${name}`;
  const branchExists = await git(status.mainToplevel, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (!branchExists.ok) {
    const created = await git(status.mainToplevel, ["branch", branch, "HEAD"], 3e4);
    if (!created.ok) throw new Error(created.message);
  }
  return createWorktreeFromBranch(cwd, branch);
}
async function removeWorktree(cwd, target) {
  if (typeof target !== "string" || !isAbsolute(target)) throw new Error("\u9700\u8981 worktree \u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002");
  const status = await repoStatus(cwd);
  if (!status.repo || !status.mainToplevel) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  const item = status.worktrees.find((entry) => canonical(entry.path) === canonical(target));
  if (item === void 0 || item.main) throw new Error("\u8BE5\u76EE\u5F55\u4E0D\u662F\u8FD9\u4E2A\u4ED3\u5E93\u7684\u4EFB\u52A1\u7A7A\u95F4\u3002");
  const removed = await git(status.mainToplevel, ["worktree", "remove", item.path], 6e4);
  if (!removed.ok) throw new Error(removed.message);
  forgetSpace(item.path);
  return { path: item.path };
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
async function createBranch(cwd, name) {
  if (typeof name !== "string") throw new Error("\u5206\u652F\u540D\u4E0D\u5408\u6CD5\u3002");
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(trimmed) || trimmed.includes("..") || trimmed.endsWith("/") || trimmed.endsWith(".lock")) {
    throw new Error("\u5206\u652F\u540D\u53EA\u80FD\u5305\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u548C\u4E2D\u5212\u7EBF\u3002");
  }
  const status = await repoStatus(cwd);
  if (!status.repo || !status.mainToplevel) throw new Error("\u5F53\u524D\u76EE\u5F55\u4E0D\u662F\u672C\u673A Git \u4ED3\u5E93\u5DE5\u4F5C\u6811\u3002");
  if (status.commits <= 0) throw new Error("\u4ED3\u5E93\u8FD8\u6CA1\u6709\u63D0\u4EA4\uFF0C\u65E0\u6CD5\u521B\u5EFA\u5206\u652F\u3002");
  const exists = await git(status.mainToplevel, ["rev-parse", "--verify", "--quiet", `refs/heads/${trimmed}`]);
  if (exists.ok) throw new Error(`\u5206\u652F\u5DF2\u5B58\u5728\uFF1A${trimmed}`);
  const created = await git(status.mainToplevel, ["branch", trimmed, "HEAD"], 3e4);
  if (!created.ok) throw new Error(created.message);
  return createWorktreeFromBranch(cwd, trimmed);
}
async function applyWorking(agent, path) {
  const current = (() => {
    try {
      return ctx.workingDirectory.get(agent.session);
    } catch {
      return void 0;
    }
  })();
  if (current !== void 0 && canonical(current) === canonical(path)) return;
  await agent.session.append("working-directory/change", { cwd: path });
}
async function pointSession(sessionId, path) {
  if (!sessionId) throw new Error("\u7F3A\u5C11 sessionId\u3002");
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("\u9700\u8981\u76EE\u6807\u76EE\u5F55\u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002");
  const entry = readStore();
  if (!existsSync(path)) {
    delete entry[sessionId];
    writeStore(entry);
    return { deferred: false, missing: true };
  }
  const agent = ctx.agents.get(sessionId);
  if (agent !== void 0) {
    await applyWorking(agent, path);
    delete entry[sessionId];
    writeStore(entry);
    return { deferred: false };
  }
  entry[sessionId] = path;
  writeStore(entry);
  return { deferred: true };
}
async function armSession(sessionId, payload) {
  if (!sessionId) throw new Error("\u7F3A\u5C11 sessionId\u3002");
  const mode = String(payload.mode ?? "");
  if (mode !== "worktree" && mode !== "local") throw new Error("\u672A\u77E5\u7684\u6A21\u5F0F\u3002");
  const cwd = String(payload.cwd ?? "");
  if (!cwd) throw new Error("\u7F3A\u5C11\u5DE5\u4F5C\u76EE\u5F55\u3002");
  const arms = readArms();
  if (mode === "local") {
    arms[sessionId] = { mode, cwd };
  } else {
    const ref = typeof payload.ref === "string" && payload.ref ? payload.ref : void 0;
    const newBranch = typeof payload.newBranch === "string" && payload.newBranch ? payload.newBranch : void 0;
    if (ref === void 0 && newBranch === void 0) throw new Error("\u7F3A\u5C11\u76EE\u6807\u5206\u652F\u3002");
    arms[sessionId] = { mode, cwd, ref, newBranch, carry: payload.carry === true ? true : void 0 };
  }
  writeArms(arms);
  return arms[sessionId];
}
function cancelArm(sessionId) {
  const arms = readArms();
  if (arms[sessionId] === void 0) return { cancelled: false };
  delete arms[sessionId];
  writeArms(arms);
  return { cancelled: true };
}
async function consumeArm(agent) {
  const arms = readArms();
  const arm = arms[agent.session.id];
  if (arm === void 0) return;
  try {
    if (arm.mode === "local") {
      const status = await repoStatus(arm.cwd);
      if (status.mainToplevel) await applyWorking(agent, status.mainToplevel);
    } else {
      const created = arm.newBranch ? await createBranch(arm.cwd, arm.newBranch) : await createWorktreeFromBranch(arm.cwd, arm.ref, arm.carry === true ? { carry: true, from: await currentWorkingDir(arm.cwd, agent.session.id) } : void 0);
      await applyWorking(agent, created.path);
    }
    const landed = readArms();
    delete landed[agent.session.id];
    writeArms(landed);
  } catch (error) {
    const message = String(error?.message ?? error);
    console.warn("[qwt] \u53D1\u9001\u65F6\u5207\u5165 Worktree \u5931\u8D25:", error);
    const latest = readArms();
    latest[agent.session.id] = { ...latest[agent.session.id] ?? arm, error: message };
    writeArms(latest);
  }
}
async function currentWorkingDir(cwd, sessionId) {
  const working = sessionWorkingPath(sessionId);
  if (working !== void 0 && existsSync(working)) return working;
  const status = await repoStatus(cwd);
  return status.workingPath && existsSync(status.workingPath) ? status.workingPath : cwd;
}
async function handle(endpoint, payload) {
  if (endpoint === "status") return ok(await repoStatus(String(payload.cwd ?? ""), String(payload.sessionId ?? "")));
  if (endpoint === "create") return ok(await createWorktree(String(payload.cwd ?? ""), payload.name));
  if (endpoint === "remove") return ok(await removeWorktree(String(payload.cwd ?? ""), payload.path));
  if (endpoint === "branches") return ok(await listBranches(String(payload.cwd ?? "")));
  if (endpoint === "fetch") return ok(await fetchBranches(String(payload.cwd ?? "")));
  if (endpoint === "branch") return ok(await createWorktreeFromBranch(String(payload.cwd ?? ""), payload.ref));
  if (endpoint === "new-branch") return ok(await createBranch(String(payload.cwd ?? ""), payload.name));
  if (endpoint === "use") return ok(await pointSession(String(payload.sessionId ?? ""), String(payload.path ?? "")));
  if (endpoint === "arm") return ok(await armSession(String(payload.sessionId ?? ""), payload));
  if (endpoint === "arm-cancel") return ok(cancelArm(String(payload.sessionId ?? "")));
  return fail(`Unknown endpoint: ${endpoint}`);
}
var inject = ["connection", "agents", "workingDirectory"];
function apply(hostCtx) {
  ctx = hostCtx;
  ctx.effect(() => ctx.on("agent/created", ({ agent }) => {
    const entry = readStore();
    const target = entry[agent.session.id];
    if (target === void 0) return;
    delete entry[agent.session.id];
    writeStore(entry);
    if (!existsSync(target)) return;
    return applyWorking(agent, target).catch((error) => console.warn("[qwt] \u5207\u5165 worktree \u5931\u8D25:", error));
  }), "dsh-qoder-worktree agent/created");
  ctx.effect(() => ctx.on("agent/inbox/inserted", ({ agent }) => {
    void consumeArm(agent);
  }), "dsh-qoder-worktree agent/inbox/inserted");
  for (const endpoint of ENDPOINTS) {
    ctx.connection.fetch.register({
      path: `${API_PREFIX}/${endpoint}`,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        let message;
        try {
          message = await request.json();
        } catch {
          return Response.json({ type: "server-response", rpcId: "", result: fail("\u8BF7\u6C42\u4F53\u4E0D\u662F JSON\u3002") });
        }
        const rpcId = typeof message?.rpcId === "string" ? message.rpcId : "";
        if (message?.type !== "client-request" || message?.method !== `dsh-qoder-worktree/${endpoint}`) {
          return Response.json({ type: "server-response", rpcId, result: fail(`\u671F\u671B method "dsh-qoder-worktree/${endpoint}"\u3002`) });
        }
        try {
          const payload = message.payload !== null && typeof message.payload === "object" && !Array.isArray(message.payload) ? message.payload : {};
          const result = await handle(endpoint, payload);
          return Response.json({ type: "server-response", rpcId, result });
        } catch (error) {
          return Response.json({ type: "server-response", rpcId, result: fail(String(error?.message ?? error)) });
        }
      }
    });
  }
  return void 0;
}
export {
  apply,
  inject
};
