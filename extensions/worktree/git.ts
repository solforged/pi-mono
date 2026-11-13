// Git helpers for the worktree extension; see docs/worktree.md.
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { hostGit } from "../sandbox/hostgit.ts";

export type Run = (args: string[], cwd: string, input?: string) => Promise<string>;
export const git: Run = (args, cwd, input) => new Promise((done, fail) => {
  const call = hostGit(cwd, args);
  const child = execFile("git", call.args, { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...call.env, GIT_OPTIONAL_LOCKS: "0" } },
    (error, stdout, stderr) => error ? fail(new Error((stderr || error.message).trim())) : done(stdout.replace(/\n+$/, "")));
  // Git can exit before reading stdin; its exit status reports any failure.
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") fail(error); });
  child.stdin?.end(input ?? "");
});

export interface Checkout {
  top: string;      // This checkout's root.
  main: string;     // The main worktree's root.
  repo: string;     // Repository key: the main root's directory name, as `ga` uses.
  linked: boolean;  // A linked worktree rather than the main checkout.
  branch?: string;
}

/** The checkout containing `cwd`, or undefined outside Git or in a bare repository. */
export async function inspect(cwd: string, run = git): Promise<Checkout | undefined> {
  let out: string;
  try { out = await run(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"], cwd); }
  catch { return undefined; }
  const [top, common, gitDir] = out.split("\n");
  if (!top || !common || !gitDir) return undefined;
  const [first] = await worktrees(cwd, run);
  if (!first || first.bare) return undefined;
  const main = first.path;
  const branch = await run(["branch", "--show-current"], cwd).catch(() => "") || undefined;
  return { top, main, repo: basename(main), linked: resolve(gitDir) !== resolve(common), branch };
}

export interface Worktree { path: string; branch?: string; bare: boolean }

/** Every worktree of the repository, the main one first. */
export async function worktrees(cwd: string, run = git): Promise<Worktree[]> {
  return (await run(["worktree", "list", "--porcelain"], cwd)).split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const field = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
    return { path: field("worktree")!, branch: field("branch")?.replace(/^refs\/heads\//, ""), bare: lines.includes("bare") };
  });
}

export const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel.startsWith("..") && !isAbsolute(rel); };

/** The worktree that `path` is in: the deepest one, since a worktree can sit inside another's folder. */
export const owner = (trees: Worktree[], path: string) => trees.filter((tree) => inside(resolve(tree.path), resolve(path)))
  .sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0];

/** Whether an edit/write `path` argument, resolved like Pi's tools, falls in the main checkout. */
export function editsMainCheckout(checkout: Checkout | undefined, cwd: string, path: unknown) {
  if (!checkout || checkout.linked || typeof path !== "string") return false;
  return inside(checkout.top, resolve(cwd, path.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir())));
}

const FILLER = new Set(["a", "an", "the", "of", "for", "to", "and", "or", "with", "in", "on", "into", "from", "by", "as", "at", "via", "its"]);

/** A short branch and directory name: the first three non-filler words, at most `max` characters. */
export function slugify(text: string, max = 28): string | undefined {
  const words = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((word) => !FILLER.has(word));
  let slug = "";
  for (const word of (kept.length ? kept : words).slice(0, 3)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > max) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, max) || undefined;
}

/** `$PI_WORKTREE_DIR` or ~/.pi/wt; a relative override is refused. */
export function worktreeRoot(env = process.env): string {
  const root = env.PI_WORKTREE_DIR;
  if (root === undefined || root === "") return join(homedir(), ".pi", "wt");
  if (!isAbsolute(root)) throw new Error(`PI_WORKTREE_DIR must be absolute: ${root}`);
  return root;
}

const exists = (path: string) => lstat(path).then(() => true, () => false);
const hasBranch = (name: string, cwd: string, run: Run) => run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], cwd).then(() => true, () => false);
const OWNER = (branch: string) => `branch.${branch}.piSession`;

/** The first `pi/<slug>[-n]` branch name not in use, other than `current`. */
async function freeBranch(slug: string, cwd: string, run: Run, current?: string) {
  for (let n = 1; ; n++) {
    const name = `pi/${slug}${n > 1 ? `-${n}` : ""}`;
    if (name === current || !await hasBranch(name, cwd, run)) return name;
  }
}

export interface Created { path: string; branch: string; dirty: boolean }

/** Adds `<root>/<repo>--<slug>` on a new `pi/<slug>` branch from this checkout's HEAD, owned by `sessionId`. */
export async function create(from: Checkout, slug: string, sessionId: string, options: { root?: string; run?: Run; trust?: (path: string) => Promise<unknown> } = {}): Promise<Created> {
  const run = options.run ?? git;
  const root = options.root ?? worktreeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  let path = "", branch = "";
  for (let n = 1; ; n++) {
    const suffix = n > 1 ? `-${n}` : "";
    path = join(root, `${from.repo}--${slug}${suffix}`);
    branch = `pi/${slug}${suffix}`;
    if (!await exists(path) && !await hasBranch(branch, from.top, run)) break;
  }
  const dirty = !!await run(["status", "--porcelain"], from.top);
  await run(["worktree", "add", "-b", branch, path, "HEAD"], from.top);
  await run(["config", "--local", OWNER(branch), sessionId], path);
  await (options.trust ?? trustMise)(path).catch(() => undefined);
  return { path: await realpath(path), branch, dirty };
}

const trustMise = (path: string) => new Promise((done) => execFile("mise", ["trust", "--quiet", path], { timeout: 10_000 }, () => done(undefined)));

const hasUpstream = (branch: string, cwd: string, run: Run) => run(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], cwd).then(() => true, () => false);

/** Whether `branch` was created for `sessionId` and has never had an upstream. */
export async function owned(branch: string | undefined, sessionId: string, cwd: string, run = git) {
  if (!branch?.startsWith("pi/")) return false;
  if (await run(["config", "--get", OWNER(branch)], cwd).catch(() => "") !== sessionId) return false;
  return !await hasUpstream(branch, cwd, run);
}

export interface Landed { target: string; commits: number; rebased: boolean }

/**
 * Lands a clean worktree's branch on the main checkout's branch without a merge
 * commit: rebases it when the target has moved on, then fast-forwards the target.
 * A failed rebase is aborted, leaving both branches as they were; only real
 * conflicts are reported as such, other failures pass Git's error through.
 */
export async function land(checkout: Checkout, run = git): Promise<Landed> {
  const { top, main, branch } = checkout;
  if (!checkout.linked || !branch) throw new Error("Land from a linked worktree that is on a branch");
  const target = await run(["branch", "--show-current"], main);
  if (!target) throw new Error(`${main} has a detached HEAD; check out the branch to land on`);
  if (await run(["status", "--porcelain"], top)) throw new Error("Commit or discard the worktree's changes first");
  const commits = Number(await run(["rev-list", "--count", `${target}..${branch}`], top));
  if (!commits) throw new Error(`${branch} has no commits that ${target} lacks`);
  const behind = Number(await run(["rev-list", "--count", `${branch}..${target}`], top));
  if (behind) {
    if (await hasUpstream(branch, top, run)) throw new Error(`${branch} has an upstream and ${target} has moved on; rebase it yourself, then land`);
    try { await run(["rebase", target], top); }
    catch (error) {
      const conflicted = await run(["diff", "--name-only", "--diff-filter=U"], top).catch(() => "");
      await run(["rebase", "--abort"], top).catch(() => undefined);
      if (conflicted) throw new Error(`Rebasing ${branch} onto ${target} conflicts. Run git rebase ${target} in ${top}, resolve it, then land again`);
      throw new Error(`Rebasing ${branch} onto ${target} failed: ${(error as Error).message}`);
    }
  }
  await run(["merge", "--ff-only", branch], main);
  return { target, commits, rebased: behind > 0 };
}

/** Renames an owned, unpushed branch to follow the session title; returns the new name if renamed. */
export async function followTitle(checkout: Checkout, sessionId: string, title: string, run = git): Promise<string | undefined> {
  const slug = slugify(title);
  const branch = checkout.branch;
  if (!slug || !branch || !await owned(branch, sessionId, checkout.top, run)) return undefined;
  if (new RegExp(`^pi/${slug}(-\\d+)?$`).test(branch)) return undefined;
  const next = await freeBranch(slug, checkout.top, run, branch);
  if (next === branch) return undefined;
  await run(["branch", "-m", branch, next], checkout.top);
  return next;
}

/** Removes a clean worktree, then its branch if this session owns it and it is merged into the main checkout's HEAD. */
export async function remove(path: string, branch: string | undefined, sessionId: string, main: string, run = git): Promise<string> {
  if (await run(["status", "--porcelain"], path)) return `Kept ${path}: it has uncommitted changes.`;
  const own = branch ? await run(["config", "--get", OWNER(branch)], path).catch(() => "") === sessionId : false;
  await run(["worktree", "remove", path], main);
  if (!branch || !own) return `Removed ${path}.`;
  try { await run(["branch", "-d", branch], main); return `Removed ${path} and ${branch}.`; }
  catch { return `Removed ${path}; kept ${branch} because it is not merged into ${main}'s HEAD.`; }
}
