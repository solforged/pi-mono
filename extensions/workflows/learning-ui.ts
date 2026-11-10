import { join } from "node:path";
import { SessionManager, withFileMutationQueue, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configSnapshot, type ConfigSource } from "./roles.ts";
import { completeRole } from "./requests.ts";
import { hash, privateDir, readJson, saveJson, scopeRoot, withLock } from "./state.ts";
import { applyDraft, evidenceChunks, evidenceFromBranch, INVENTORY_LABEL, inventoryInput, inventorySkills, LEARNING_SYSTEM, parseCandidates, readDrafts, renderDraft, skillRef, stageCandidate } from "./learning.ts";
import { cancellable, pickMany } from "./ui.ts";

type Ledger = { sessions: Record<string, string[]>; curated: Record<string, string> };
export function registerLearning(pi: ExtensionAPI, source: ConfigSource, agentDir: string, lifetime: AbortSignal, report: (ctx: ExtensionCommandContext, text: string) => void) {
  const profile = configSnapshot(source).profile;
  let busy = false;
  pi.on("resources_discover", async (_event, ctx) => {
    const skills = join(await scopeRoot(agentDir, profile, ctx.cwd), "skills");
    await privateDir(skills);
    return { skillPaths: [skills] };
  });

  async function review(ctx: ExtensionCommandContext, sources: Array<{ id: string; entries: any[]; file?: string }>, curate: boolean) {
    const config = configSnapshot(source); // Every chunk in this review uses the same model.
    if (busy) throw new Error("A learning review is already running");
    busy = true;
    try {
      const root = await scopeRoot(agentDir, config.profile, ctx.cwd);
      await cancellable(ctx, `Reviewing with ${config.profile}.learn; no skills will be activated`, lifetime, async (signal) => withLock(root, "review", async () => {
        const loaded = ctx.getSystemPromptOptions().skills ?? [];
        const inventory = await inventorySkills(root, loaded);
        const skillRefs = inventory.map(skillRef);
        const inventoryText = inventoryInput(inventory, loaded);
        const budget = config.learning.maxInputChars - inventoryText.length - LEARNING_SYSTEM.length - 1500;
        if (budget < 4000) throw new Error("Managed skills exceed the learning input budget; raise learning.maxInputChars");
        const ledgerFile = join(root, "reviewed.json");
        const ledger = await readJson<Ledger>(ledgerFile, { sessions: {}, curated: {} });
        let remaining = config.learning.maxChunks, proposals = 0, reviewed = 0, pending = 0;
        const generate = async (evidence: string, refs: string[], focus: string) => {
          signal.throwIfAborted();
          const result = await completeRole(ctx, config, "learn", LEARNING_SYSTEM,
            `Candidate limit: ${config.learning.maxCandidates}\nFocus: ${focus}\n${INVENTORY_LABEL}:\n${inventoryText}\nEvidence:\n${evidence}`, signal);
          signal.throwIfAborted();
          pi.appendEntry("workflow-usage", { role: "learn", ...result, text: undefined });
          const candidates = parseCandidates(result.text, new Set([...refs, ...skillRefs]), config.learning.maxCandidates);
          if (new Set(candidates.map((c) => c.name)).size !== candidates.length) throw new Error("Multiple changes proposed for the same skill; retry the review");
          for (const candidate of candidates) {
            signal.throwIfAborted();
            await stageCandidate(root, candidate, inventory);
            proposals++;
          }
        };
        if (curate) {
          const owned = inventory.filter((skill) => skill.managed && ledger.curated[skill.name] !== hash(skill.content));
          for (const skill of owned) {
            if (remaining <= 0) { pending++; continue; }
            const ref = skillRef(skill);
            await generate(JSON.stringify({ ref, content: skill.content }), [ref], `Audit managed skill ${skill.name}; keep uncertain value and preserve unique details before proposing merges or deletions.`);
            ledger.curated[skill.name] = hash(skill.content); remaining--; reviewed++;
            await saveJson(ledgerFile, ledger);
          }
        } else {
          for (const source of sources) {
            const previous = new Set(ledger.sessions[source.id] ?? []);
            const evidence = evidenceFromBranch(source.entries, source.id, previous);
            const chunks = evidenceChunks(evidence, budget).filter((chunk) => !chunk.entryIds.every((id) => previous.has(id)));
            for (const chunk of chunks) {
              if (remaining <= 0) { pending++; continue; }
              await generate(chunk.text, chunk.refs, "Extract only reusable, demonstrated procedures or durable facts; failed attempts are not proof a procedure works.");
              chunk.entryIds.forEach((id) => previous.add(id));
              ledger.sessions[source.id] = [...previous]; remaining--; reviewed++;
              await saveJson(ledgerFile, ledger);
            }
          }
        }
        signal.throwIfAborted();
        report(ctx, `Reviewed ${reviewed} ${curate ? "skills" : "chunks"}; ${proposals} proposals staged; ${pending} still pending. Use /learn-review to inspect exact changes. No skills were activated.`);
      }));
    } finally { busy = false; }
  }

  pi.registerCommand("learn", {
    description: "Describe a flow; this model authors a managed skill",
    handler: async (args, ctx) => {
      await ctx.waitForIdle(); lifetime.throwIfAborted();
      const dest = join(await scopeRoot(agentDir, profile, ctx.cwd), "skills");
      await privateDir(dest);
      const request = args.trim() || "(ask which flow to capture)";
      pi.sendUserMessage(`Author a reusable skill from this request. Write it to ${dest}/<slug>/SKILL.md so this workflow can load and later curate it.\n\nRequest: ${request}\n\nA skill is a reusable multi-step procedure with a clear trigger, steps, verification, and pitfalls. If the steps are mechanical, say so and offer a script or task instead before writing a skill. Name a new skill with a gerund, such as processing-pdfs, never containing anthropic or claude; write the description in the third person, saying what it does and when to use it. Isolated durable facts belong in their owning wiki note, not a skill. Prefer updating an existing managed skill in that directory over a near-duplicate. Do not invent steps you have not seen or been told. No executable scripts.\n\nFrontmatter must be exactly:\n---\nname: the-slug\ndescription: "a JSON-quoted single-line description"\n---\nthen the procedure, ending with a newline. After writing, tell the user to /reload so the skill is discovered.`);
    },
  });
  pi.registerCommand("learn-sessions", {
    description: "Pick sessions to mine for skill proposals; stage only",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("/learn-sessions needs an interactive picker");
      await ctx.waitForIdle(); lifetime.throwIfAborted();
      const sessions = (await SessionManager.list(ctx.cwd)).slice(0, 30);
      const currentFile = ctx.sessionManager.getSessionFile();
      const currentId = ctx.sessionManager.getSessionId();
      const initial = sessions.filter((s) => s.path === currentFile || s.id === currentId).map((s) => s.path);
      const paths = await pickMany(ctx, "Choose project sessions", sessions.map((s) => ({
        value: s.path, label: s.name || s.firstMessage || s.id,
      })), lifetime, 10, initial);
      if (!paths) return;
      const selected: Array<{ id: string; file: string; entries: any[] }> = [];
      for (const path of paths) {
        const session = sessions.find((s) => s.path === path);
        if (!session) continue;
        const sm = SessionManager.open(session.path);
        const entries = sm.getEntries();
        const parents = new Set(entries.map((e) => e.parentId));
        const leaves = entries.filter((e) => !parents.has(e.id));
        let leaf = sm.getLeafId();
        if (leaves.length > 1) {
          const branches = leaves.map((e) => `${e.id} · ${e.timestamp}`);
          const branch = await ctx.ui.select("Choose branch to review", branches);
          if (!branch) return;
          leaf = leaves[branches.indexOf(branch)].id;
        }
        selected.push({ id: sm.getSessionId(), file: session.path, entries: sm.getBranch(leaf ?? undefined) });
      }
      lifetime.throwIfAborted();
      if (selected.length) await review(ctx, selected, false);
      else report(ctx, "No sessions selected");
    },
  });
  pi.registerCommand("curate-skills", {
    description: "Audit changed, workflow-managed skills; authored/project skills stay read-only",
    handler: async (_args, ctx) => { await ctx.waitForIdle(); lifetime.throwIfAborted(); await review(ctx, [], true); },
  });
  pi.registerCommand("learn-review", {
    description: "Inspect, approve or dismiss a staged skill proposal; never auto-approve",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("Skill activation requires interactive review and approval");
      await ctx.waitForIdle(); lifetime.throwIfAborted();
      const root = await scopeRoot(agentDir, profile, ctx.cwd);
      const draftsDir = join(root, "drafts");
      await privateDir(draftsDir);
      const drafts = (await readDrafts(root)).filter((draft) => draft.status === "pending");
      if (!drafts.length) { report(ctx, "No pending skill proposals"); return; }
      const labels = drafts.map((d, i) => `${i + 1}. ${d.action} ${d.name}${d.origin ? ` (${d.origin})` : ""}`);
      const choice = await ctx.ui.select("Pending proposals", labels);
      if (!choice) return;
      const draft = drafts[labels.indexOf(choice)];
      const preview = renderDraft(draft);
      const inspected = await ctx.ui.editor("Review proposal; submit unchanged to continue, Escape to keep pending", preview);
      if (inspected === undefined) return;
      if (inspected !== preview) { report(ctx, "Preview edits are not applied. Proposal remains pending; edit the draft file and review it again."); return; }
      const decisions = draft.action === "note" ? ["Keep pending", "Dismiss"]
        : draft.action === "automate" ? ["Keep pending", "Ask the agent to build it", "Dismiss"]
        : ["Keep pending", "Approve exact change", "Dismiss"];
      const action = await ctx.ui.select("Proposal decision", decisions);
      lifetime.throwIfAborted();
      if (!action || action === "Keep pending") return;
      if (action === "Dismiss" || action === "Ask the agent to build it") {
        draft.status = action === "Dismiss" ? "dismissed" : "applied";
        await saveJson(join(draftsDir, `${draft.id}.json`), draft);
        if (action === "Dismiss") { report(ctx, `Dismissed ${draft.name}`); return; }
        pi.sendUserMessage(`Build this deterministic tooling so the workflow no longer needs a skill. Follow the project's conventions, keep it small, and verify it before reporting back.\n\n${draft.reason}\n\n${draft.content}`);
        return;
      }
      const digest = hash(preview);
      if (!await ctx.ui.confirm(`Apply ${draft.action}: ${draft.name}?`, `Only this exact diff (${digest.slice(0, 12)}) will be applied. Source: ${draft.id}`)) return;
      lifetime.throwIfAborted();
      await applyDraft(root, draft, digest, withFileMutationQueue);
      report(ctx, `Applied ${draft.action}: ${draft.name}. Reloading skills.`);
      await ctx.reload(); return;
    },
  });
}
