// The worktree extension's view of a checkout: Git worktrees and branches, or
// jj workspaces in a colocated jj repository. See docs/worktree.md.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { jjRefusal, trustedLayout } from "../sandbox/hostgit.ts";
import * as G from "./git.ts";
import * as J from "./jj.ts";
import type { Checkout, Run } from "./git.ts";

export { editsMainCheckout, git, inside, owner, slugify, worktreeRoot, type Checkout, type Created, type Worktree } from "./git.ts";

const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * The checkout containing `cwd`. A jj workspace counts only where it is also
 * the Git checkout's root, that is, colocated, and was there when the sandbox
 * started, if it is on; one that jj must not run in counts as none. See
 * `unsupported` for why.
 */
export async function inspect(cwd: string, run = G.git, vcs = J.jj): Promise<Checkout | undefined> {
  const checkout = await G.inspect(cwd, run);
  if (!checkout) return undefined;
  const top = canonical(checkout.top);
  const layout = trustedLayout(cwd);
  if (layout?.jj && canonical(layout.workTree) === top) return jjRefusal(layout) ? undefined : J.inspectJj(checkout, vcs).catch(() => checkout);
  // A jj workspace inside a Git checkout is not colocated.
  const root = J.jjRoot(cwd);
  if (root && root !== top && G.inside(top, root)) return undefined;
  return checkout;
}

/** Why /wt does not work at `cwd`, when that is about jj: a workspace without its own Git checkout, or one jj must not run in. */
export async function unsupported(cwd: string, run = G.git): Promise<string | undefined> {
  const root = J.jjRoot(cwd);
  if (!root) return undefined;
  const top = await run(["rev-parse", "--path-format=absolute", "--show-toplevel"], cwd).catch(() => "");
  if (top && canonical(top) === root) {
    const layout = trustedLayout(cwd);
    return layout?.jj ? jjRefusal(layout) : undefined;
  }
  if (top && G.inside(root, canonical(top))) return undefined;
  return `${root} is a jj workspace without its own Git checkout. /wt needs a colocated repository: run jj git colocation enable in the main workspace, and add workspaces with --colocate.`;
}

export const worktrees = (checkout: Checkout, run: Run = G.git) =>
  checkout.vcs === "jj" ? J.workspaces(checkout.top) : G.worktrees(checkout.top, run);

/** Whether the checkout at `path`, by default `checkout`'s own, has changes not yet committed. */
export const dirty = async (checkout: Checkout, path = checkout.top, run: Run = G.git) =>
  checkout.vcs === "jj" ? J.dirtyJj(path) : !!await run(["status", "--porcelain"], path);

export const create = (from: Checkout, slug: string, sessionId: string, options?: Parameters<typeof G.create>[3]) =>
  from.vcs === "jj" ? J.createJj(from, slug, sessionId, options) : G.create(from, slug, sessionId, options);

export const followTitle = (checkout: Checkout, sessionId: string, title: string, run: Run = G.git) =>
  checkout.vcs === "jj" ? J.followTitleJj(checkout, sessionId, title, run) : G.followTitle(checkout, sessionId, title, run);

export const land = (checkout: Checkout, run: Run = G.git) =>
  checkout.vcs === "jj" ? J.landJj(checkout) : G.land(checkout, run);

/** Removes the checkout at `path` of `checkout`'s repository, with what it owns; see the Git and jj versions. */
export const remove = (checkout: Checkout, path: string, branch: string | undefined, sessionId: string, run: Run = G.git) =>
  checkout.vcs === "jj" ? J.removeJj(path, branch, checkout.main, run) : G.remove(path, branch, sessionId, checkout.main, run);

/** What the checkout's branch is called in reports: a branch, or a jj workspace. */
export const unit = (checkout: Checkout) => checkout.vcs === "jj" ? "workspace" : "branch";
