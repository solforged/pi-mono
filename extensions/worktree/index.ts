// Moves a session into its own Git worktree and branch, as Claude Code's
// EnterWorktree does, keeps the branch named after the session title, and
// lands or resumes worktree sessions. See docs/worktree.md.
import { stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { create, editsMainCheckout, followTitle, git as run, inside, inspect, land, owner, remove, slugify, worktreeRoot, worktrees, type Checkout, type Created } from "./git.ts";
import { copyIncluded, INCLUDE_FILE } from "./include.ts";
import { relocate, repositorySessionDirs, sessionChoices, type Listed } from "./session.ts";

const TOOL = "enter_worktree";
const EDITORS = new Set(["edit", "write"]);
const ACTIONS = ["status", "enter", "exit", "land", "resume"];
const USAGE = "Usage: /wt [status|enter [name]|exit [keep|remove]|land [keep|remove|stay]|resume]";

type Prepared = Created & { copied: number };
type Moved = ExtensionCommandContext & { sendMessage: (message: any, options?: any) => Promise<void> };

export default function (pi: ExtensionAPI) {
  // Rex and workflow children already run in worker worktrees chosen by their parent.
  if (process.env.PI_REX_CHILD || process.env.PI_WORKFLOW_CHILD_CONFIG) return;
  let checkout: Checkout | undefined;
  let pending: Prepared | undefined;
  let warned: string | undefined; // The assistant message whose edits were turned back.

  const say = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, level); else console.log(text);
  };
  // Offer the tool only where it applies, so worktree sessions carry no guidance for it.
  function offer(on: boolean) {
    const active = pi.getActiveTools();
    if (on === active.includes(TOOL)) return;
    pi.setActiveTools(on ? [...active, TOOL] : active.filter((name) => name !== TOOL));
  }
  async function follow(ctx: ExtensionContext, title = pi.getSessionName()) {
    if (!checkout?.linked || !title) return;
    try {
      const next = await followTitle(checkout, ctx.sessionManager.getSessionId(), title, run);
      if (next) { checkout.branch = next; say(ctx, `Branch renamed to ${next}`); }
    } catch (error) { say(ctx, `Could not rename the branch: ${(error as Error).message}`, "warning"); }
  }
  const linked = () => { if (!checkout?.linked) throw new Error("Not in a linked worktree"); return checkout; };

  pi.on("session_start", async (_event, ctx) => {
    pending = undefined; warned = undefined;
    checkout = await inspect(ctx.cwd, run);
    offer(!!checkout && !checkout.linked && !!ctx.sessionManager.getSessionFile());
    await follow(ctx);
    await stray(ctx);
  });

  // `pi -c` runs the newest session in the current directory, which may be one that
  // moved to a worktree: its file stays in the main checkout's session folder.
  async function stray(ctx: ExtensionContext) {
    const home = (ctx.sessionManager.getHeader() as { cwd?: unknown } | null)?.cwd;
    if (!checkout || typeof home !== "string" || resolve(home) === resolve(ctx.cwd)) return;
    const all = await worktrees(checkout.top, run).catch(() => []);
    const tree = owner(all, home);
    if (tree && tree !== owner(all, ctx.cwd)) say(ctx, `This session works in ${home}${tree.branch ? ` on ${tree.branch}` : ""} but is running in ${ctx.cwd}. Reopen it with /resume or pi --resume to work there.`, "warning");
  }
  pi.on("session_info_changed", async (event, ctx) => { await follow(ctx, event.name); });

  async function prepare(ctx: ExtensionContext, name?: string): Promise<Prepared> {
    if (pending) return pending;
    if (!checkout) throw new Error("Not in a Git repository with a working tree");
    if (checkout.linked) throw new Error(`Already in the linked worktree ${checkout.top}`);
    if (!ctx.sessionManager.getSessionFile()) throw new Error("This session has no file (--no-session), so it cannot move");
    const id = ctx.sessionManager.getSessionId();
    const slug = slugify(pi.getSessionName() ?? "") ?? slugify(name ?? "") ?? `session-${id.replace(/-/g, "").slice(-8)}`;
    const made = await create(checkout, slug, id);
    const copied = await copyIncluded(checkout.top, made.path).catch((error) => {
      say(ctx, `Could not copy ${INCLUDE_FILE} files: ${(error as Error).message}`, "warning");
      return [];
    });
    return { ...made, copied: copied.length };
  }
  const describe = (target: Prepared, origin: string) => [
    target.copied ? ` Copied ${target.copied} file(s) listed in ${INCLUDE_FILE}.` : "",
    target.dirty ? ` Uncommitted changes in ${origin} were not copied.` : "",
  ].join("");

  // Notifications sent right after a switch are lost, so reports go into the
  // session, where the model also learns where it now is.
  const report = (next: Moved, content: string, triggerTurn = false) =>
    next.sendMessage({ customType: "worktree", content, display: true }, { triggerTurn });

  /**
   * The folder in the checkout at `root` that matches the session's folder in
   * this one, so a session started in a subfolder stays in it; the root when
   * that checkout has no such folder.
   */
  async function counterpart(root: string, cwd: string) {
    const rel = relative(checkout!.top, cwd);
    if (!rel || !inside(checkout!.top, cwd)) return root;
    const path = join(root, rel);
    return await stat(path).then((s) => s.isDirectory(), () => false) ? path : root;
  }

  /**
   * Points this session at `cwd` and switches to it, then runs `after` in the
   * moved session. `home` is the main checkout's folder of the two, whose
   * session folder keeps the file.
   */
  async function move(ctx: ExtensionCommandContext, cwd: string, home: string, after: (next: Moved) => Promise<void>) {
    await ctx.waitForIdle();
    const { file, undo } = await relocate(ctx.sessionManager, cwd, home);
    let result: { cancelled: boolean };
    try { result = await ctx.switchSession(file, { withSession: after as any }); }
    catch (error) { await undo().catch(() => undefined); throw error; }
    if (result.cancelled) { await undo(); say(ctx, "Session switch cancelled; staying here.", "warning"); }
    return !result.cancelled;
  }

  async function enter(ctx: ExtensionCommandContext, name: string | undefined) {
    const fromTool = !!pending;
    const target = await prepare(ctx, name);
    pending = undefined;
    const origin = checkout!.top;
    const notes = describe(target, origin);
    const cwd = await counterpart(target.path, ctx.cwd);
    // A worktree the session did not reach is taken back: left there, the next attempt would make a second beside it.
    const discard = async (why: string) => {
      const outcome = await remove(target.path, target.branch, ctx.sessionManager.getSessionId(), origin, run).catch((error) => `Could not remove ${target.path}: ${error.message}`);
      // The tool's result said the session would move, so the model is told that it did not.
      if (fromTool) pi.sendMessage({ customType: "worktree", content: `The session did not move to a worktree: ${why}. ${outcome} It is still in ${ctx.cwd}.`, display: true });
      return outcome;
    };
    let moved: boolean;
    try {
      moved = await move(ctx, cwd, ctx.cwd, async (next) => {
        const text = `Session moved to the worktree ${target.path} on branch ${target.branch}, created from HEAD of ${origin}.${notes} Work in ${cwd} from now on`;
        await report(next, fromTool ? `${text} and continue the task.` : `${text}.`, fromTool);
      });
    } catch (error) { throw new Error(`${(error as Error).message}. ${await discard((error as Error).message)}`); }
    if (!moved) say(ctx, await discard("the switch was cancelled"));
  }

  /** Returns to the main checkout, keeping or removing this worktree; `done` prefixes the report. */
  async function leave(ctx: ExtensionCommandContext, choice: "keep" | "remove", done = "") {
    const { top, main, branch } = linked();
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = await counterpart(main, ctx.cwd);
    await move(ctx, cwd, cwd, async (next) => {
      const outcome = choice === "remove"
        ? await remove(top, branch, sessionId, main, run).catch((error) => `Could not remove ${top}: ${error.message}`)
        : `Kept ${top}${branch ? ` on ${branch}` : ""}.`;
      await report(next, `${done}Session returned to the main checkout ${main}; work in ${cwd} from now on. ${outcome}`);
    });
  }

  async function exit(ctx: ExtensionCommandContext, choice: string | undefined) {
    const { top, main } = linked();
    if (choice !== "keep" && choice !== "remove") {
      if (!ctx.hasUI) throw new Error("Usage: /wt exit keep|remove");
      const dirty = !!await run(["status", "--porcelain"], top);
      const picked = await ctx.ui.select(`Return to ${main}`, dirty ? ["Keep worktree (uncommitted changes)"] : ["Keep worktree", "Remove worktree"]);
      if (!picked) return;
      choice = picked.startsWith("Remove") ? "remove" : "keep";
    }
    await leave(ctx, choice as "keep" | "remove");
  }

  async function landHere(ctx: ExtensionCommandContext, choice: string | undefined) {
    const here = linked();
    await ctx.waitForIdle();
    const result = await land(here, run);
    const summary = `Landed ${result.commits} commit(s) from ${here.branch} on ${result.target}${result.rebased ? " after rebasing" : ""}. `;
    if (choice !== "keep" && choice !== "remove" && choice !== "stay") {
      if (!ctx.hasUI) choice = "stay";
      else {
        const picked = await ctx.ui.select(`${summary.trim()} Then`, ["Remove worktree and return", "Return and keep worktree", "Stay here"]);
        choice = picked?.startsWith("Remove") ? "remove" : picked?.startsWith("Return") ? "keep" : "stay";
      }
    }
    if (choice === "stay") return say(ctx, summary.trim());
    await leave(ctx, choice as "keep" | "remove", summary);
  }

  /** Sessions working in the repository's other checkouts, by the cwd in their headers. */
  async function resume(ctx: ExtensionCommandContext) {
    if (!checkout) throw new Error("Not in a Git repository with a working tree");
    const all = (await worktrees(checkout.top, run)).filter((tree) => !tree.bare);
    const here = resolve(checkout.top);
    const found: Listed[] = [];
    const seen = new Set<string>();
    for (const dir of repositorySessionDirs(ctx.sessionManager.getSessionDir(), [checkout.main, checkout.top, ...all.map((tree) => resolve(tree.path))])) {
      for (const session of await SessionManager.listAll(dir).catch(() => [])) {
        // A session may work in a subfolder of its worktree.
        const tree = session.cwd ? owner(all, session.cwd) : undefined;
        if (!tree || resolve(tree.path) === here || seen.has(session.path)) continue;
        seen.add(session.path);
        found.push({ ...session, branch: tree.branch, worktree: tree.path });
      }
    }
    const choices = sessionChoices(found);
    if (!choices.length) return say(ctx, "No sessions in this repository's other worktrees.");
    if (!ctx.hasUI) return say(ctx, choices.map(({ label, session }) => `${label}\n  ${session.path}`).join("\n"));
    const picked = await ctx.ui.select("Resume a worktree session", choices.map((choice) => choice.label));
    const session = choices.find((choice) => choice.label === picked)?.session;
    if (!session) return;
    await ctx.waitForIdle();
    await ctx.switchSession(session.path);
  }

  pi.registerTool({
    name: TOOL,
    label: "Enter worktree",
    description: "Move this session into a new Git worktree and pi/<name> branch created from HEAD. Ends the current response; the session continues in the worktree.",
    promptSnippet: "Move this session into its own Git worktree and branch",
    promptGuidelines: [`Call ${TOOL} alone, before the first edit, for non-trivial work in a main checkout, unless the user asked to work in place.`],
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Fallback kebab-case name, used only when the session has no title; the branch follows the title" })) }),
    async execute(_id, params: { name?: string }, _signal, _onUpdate, ctx) {
      pending = await prepare(ctx, params.name);
      // The moved session's report carries the paths and notes; this only answers the call.
      return {
        content: [{ type: "text", text: `Worktree ready on ${pending.branch}; the session moves there next and continues the task.` }],
        details: { ...pending },
        terminate: true,
      };
    },
  });

  // Siblings are preflighted before any of them runs, so decisions cover the whole assistant message.
  const latestAssistant = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) if ((branch[i] as any).message?.role === "assistant") return branch[i] as any;
    return undefined;
  };

  pi.on("tool_call", async (event, ctx) => {
    // Without the tool there is no move to guard and no hint to give, and finding the turn walks the session.
    if (!pending && !pi.getActiveTools().includes(TOOL)) return;
    const turn = latestAssistant(ctx);
    const moving = turn?.message.content?.some?.((block: any) => block.type === "toolCall" && block.name === TOOL);
    if (event.toolName !== TOOL && (pending || moving)) return { block: true, reason: "The session is moving to its worktree; continue there after the move.", terminate: true };
    if (ctx.mode !== "tui" || !EDITORS.has(event.toolName) || !pi.getActiveTools().includes(TOOL)) return;
    // The hint is given once per session, to every edit in that message.
    if (warned && warned !== turn?.id) return;
    if (!editsMainCheckout(checkout, ctx.cwd, (event.input as { path?: unknown }).path)) return;
    warned = turn?.id ?? "";
    const dirty = !!await run(["status", "--porcelain"], checkout!.top).catch(() => "");
    const state = dirty ? " It has uncommitted changes, which a new worktree, created from HEAD, would not include." : "";
    return { block: true, reason: `This session is in the main checkout.${state} For non-trivial work, call ${TOOL} first. For a trivial change, or if the user asked to work here, retry the edit.` };
  });

  // Tools cannot switch sessions; hand the move to the command once Pi is idle.
  pi.on("agent_settled", () => {
    if (pending) pi.sendUserMessage("/wt enter", { expandPromptTemplates: true });
  });

  pi.registerCommand("wt", {
    description: "Worktree sessions: status, enter [name], exit, land, or resume a session from another worktree",
    getArgumentCompletions: (prefix: string) => {
      const items = ACTIONS.filter((action) => action.startsWith(prefix)).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (action === "enter") return await enter(ctx, rest.join(" ") || undefined);
        if (action === "exit") return await exit(ctx, rest[0]);
        if (action === "land") return await landHere(ctx, rest[0]);
        if (action === "resume") return await resume(ctx);
        if (action !== "status") return say(ctx, USAGE, "warning");
        if (!checkout) return say(ctx, "Not in a Git repository with a working tree.");
        say(ctx, checkout.linked
          ? `Worktree ${checkout.top} on ${checkout.branch ?? "a detached HEAD"}; main checkout ${checkout.main}.`
          : `Main checkout ${checkout.top} on ${checkout.branch ?? "a detached HEAD"}. New worktrees go in ${worktreeRoot()}.`);
      } catch (error) { say(ctx, (error as Error).message, "error"); }
    },
  });
}
