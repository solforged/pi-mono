// Scripted provider faults shared by fault-provider.ts and fault-smoke.ts. Data only: no Pi imports.
// A step is one model response: thinking, text and calls are streamed in that order, then the response
// ends with `error` (a provider failure carrying the partial content) or `stop` (default: toolUse with
// calls, otherwise stop). `output` is the reported output-token count: a length stop defaults to the
// model's limit, and a smaller count is what Pi treats as a context-window cut. Requests beyond the
// script get DONE. A phase is one `pi -p` process; `cut`
// edits the saved session afterwards so the next phase resumes a damaged file.
export type Call = { id: string; name?: string; args?: unknown };
export type Step = { thinking?: string; text?: string; calls?: Call[]; stop?: "stop" | "length" | "toolUse"; error?: string; output?: number };
export type Phase = { prompt: string; steps: Step[]; cut?: "after-tool-call" };
// `settings` is merged into the isolated agent settings for that scenario.
export type Scenario = { name: string; about: string; phases: Phase[]; settings?: Record<string, unknown> };

export const DONE = "FIXTURE DONE";
export const TOOL = "probe";
const call = (id: string, value = id): Call => ({ id, args: { value } });
const OVERLOADED = "529 overloaded_error: Overloaded", DROPPED = "terminated: other side closed",
  OVERFLOW = "prompt is too long: 250000 tokens > 128000 maximum";

export const SCENARIOS: Scenario[] = [
  { name: "baseline", about: "tool call, result, final text", phases: [{ prompt: "go", steps: [{ calls: [call("a")] }, { text: "All good." }] }] },
  { name: "error-before-output", about: "retryable error before any output, twice", phases: [{ prompt: "go", steps: [{ error: OVERLOADED }, { error: OVERLOADED }, { text: "Recovered." }] }] },
  { name: "error-exhausted", about: "retryable error on every attempt", phases: [{ prompt: "go", steps: Array(8).fill({ error: OVERLOADED }) }] },
  { name: "error-fatal", about: "error Pi does not classify as retryable", phases: [{ prompt: "go", steps: [{ error: "400 invalid_request_error: fixture rejects this request" }] }] },
  { name: "drop-mid-text", about: "stream dies after visible text", phases: [{ prompt: "go", steps: [{ text: "The answer is forty", error: DROPPED }, { text: "The answer is forty-two." }] }] },
  { name: "drop-mid-thinking", about: "stream dies during thinking", phases: [{ prompt: "go", steps: [{ thinking: "Considering the options", error: DROPPED }, { text: "Recovered." }] }] },
  { name: "drop-after-tool-call", about: "stream dies after a complete tool call", phases: [{ prompt: "go", steps: [{ text: "Checking.", calls: [call("a")], error: DROPPED }, { calls: [call("b")] }, { text: "Recovered." }] }] },
  { name: "drop-after-tool-result", about: "stream dies on the turn after a tool ran", phases: [{ prompt: "go", steps: [{ calls: [call("a")] }, { text: "Half a sen", error: DROPPED }, { text: "Recovered." }] }] },
  { name: "empty-stop", about: "stop with no content", phases: [{ prompt: "go", steps: [{}] }] },
  { name: "thinking-only-stop", about: "stop with thinking and nothing else", phases: [{ prompt: "go", steps: [{ thinking: "I will call the tool now." }] }] },
  { name: "empty-after-tool", about: "empty stop on the turn after a tool ran", phases: [{ prompt: "go", steps: [{ calls: [call("a")] }, {}] }] },
  { name: "length-tool-call", about: "output limit cuts a tool call's arguments", phases: [{ prompt: "go", steps: [{ calls: [{ id: "a", args: {} }], stop: "length" }, { calls: [call("b")] }, { text: "Recovered." }] }] },
  { name: "length-text", about: "output limit cuts plain text, then the user continues", phases: [
    { prompt: "go", steps: [{ text: "A long answer that stops mid", stop: "length" }, { text: "Recovered." }] },
    { prompt: "carry on", steps: [{ text: "Resumed." }] }] },
  { name: "length-thinking", about: "output limit reached while only thinking", phases: [{ prompt: "go", steps: [{ thinking: "Still reasoning about", stop: "length" }, { text: "Recovered." }] }] },
  { name: "length-text-early", about: "text cut below the output limit, then the user continues", phases: [
    { prompt: "go", steps: [{ text: "A long answer that stops mid", stop: "length", output: 10 }, { text: "Recovered." }] },
    { prompt: "carry on", steps: [{ text: "Resumed." }] }] },
  { name: "unknown-tool", about: "call to a tool that does not exist", phases: [{ prompt: "go", steps: [{ calls: [{ id: "a", name: "probe_files", args: { value: "a" } }] }, { text: "Recovered." }] }] },
  { name: "coercible-args", about: "a number where a string is required, plus an unknown key", phases: [{ prompt: "go", steps: [{ calls: [{ id: "a", args: { value: 7, extra: true } }] }, { text: "Recovered." }] }] },
  { name: "invalid-args", about: "arguments missing a required field", phases: [{ prompt: "go", steps: [{ calls: [{ id: "a", args: { text: "a" } }] }, { text: "Recovered." }] }] },
  { name: "stringified-args", about: "arguments double-encoded as a JSON string", phases: [{ prompt: "go", steps: [{ calls: [{ id: "a", args: "{\"value\":\"a\"}" }] }, { text: "Recovered." }] }] },
  { name: "duplicate-ids", about: "two calls sharing one id in a turn", phases: [{ prompt: "go", steps: [{ calls: [call("a", "first"), call("a", "second")] }, { text: "Recovered." }] }] },
  { name: "reused-id", about: "a later turn reuses an earlier call id", phases: [{ prompt: "go", steps: [{ calls: [call("a", "first")] }, { calls: [call("a", "second")] }, { text: "Recovered." }] }] },
  { name: "tool-loop", about: "the same call repeated for 12 turns", phases: [{ prompt: "go", steps: Array.from({ length: 12 }, (_, i) => ({ calls: [call(`loop-${i}`, "same")] })) }] },
  { name: "overflow", about: "provider reports context overflow with nothing to compact", phases: [{ prompt: "go", steps: [{ calls: [call("a")] }, { error: OVERFLOW }, { text: "Recovered." }] }] },
  { name: "overflow-compactable", about: "provider reports context overflow after several turns", settings: { compaction: { keepRecentTokens: 1 } }, phases: [
    { prompt: "go", steps: [{ calls: [call("a")] }, { calls: [call("b")] }, { text: "First answer." }] },
    { prompt: "more", steps: [{ calls: [call("c")] }, { error: OVERFLOW }, { text: "Recovered." }] }] },
  { name: "resume-dangling-call", about: "resume a file ending in a tool call with no result", phases: [
    { prompt: "go", steps: [{ calls: [call("a")] }, { text: "First run." }], cut: "after-tool-call" },
    { prompt: "carry on", steps: [{ text: "Resumed." }] }] },
  { name: "resume-errored-turn", about: "resume a file ending in a failed turn", phases: [
    { prompt: "go", steps: [{ text: "Half a sen", error: "400 invalid_request_error: fixture rejects this request" }] },
    { prompt: "carry on", steps: [{ text: "Resumed." }] }] },
  { name: "resume-errored-tool-turn", about: "resume a file ending in a failed turn that held a tool call", phases: [
    { prompt: "go", steps: [{ calls: [call("a")], error: "400 invalid_request_error: fixture rejects this request" }] },
    { prompt: "carry on", steps: [{ text: "Resumed." }] }] },
];
