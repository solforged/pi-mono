// Scenario for scripts/deferred-tools-eval.ts: a mock tool catalog of 29 tools in 12 groups with
// canned replies (registered by tests/fixtures/deferred-tools-catalog.ts), a small workspace, and
// tasks. Each task needs one of the mock tools, except the controls, which need none. A run
// passes when every expected tool ran and the reply, files and arguments hold what the mock returned.

export type Task = {
  id: string;
  // explicit: names the system; vocab: names it only indirectly; implicit: needs it midway through a coding task;
  // soft: bash could do the job instead; multi: needs two groups; control: needs no extra tool.
  kind: "explicit" | "vocab" | "implicit" | "soft" | "multi" | "control";
  prompt: string;
  expect: string[];
  answer?: string[];
  files?: Record<string, string[]>;
  args?: Record<string, Record<string, string>>;
};

export const WORKSPACE: Record<string, string> = {
  "README.md": `# orders-report

Reporting scripts for the orders service.

The order data lives in the staging Postgres database (\`staging-db\`). Its table
and column names do not match the ORM models in other repos, so don't guess
them.
`,
  "calc.py": `def add(a, b):
    return a + b


def apply_discount(price, pct):
    foo = price * (100 - pct) / 100
    return round(foo, 2)
`,
};

export const TASKS: Task[] = [
  { id: "jira", kind: "explicit", prompt: "What's the current status of Jira ticket PLAT-4821, and who's it assigned to?", expect: ["jira_issue_get"], answer: ["Whitfield"] },
  { id: "sessions", kind: "explicit", prompt: "In an earlier session we decided on a Postgres connection pool size for the checkout service. What did we settle on, and why?", expect: ["session_search"], answer: ["48"] },
  { id: "metrics", kind: "explicit", prompt: "Is the checkout service's production error rate elevated right now? Check the last hour.", expect: ["metrics_query"], answer: ["2.7"] },
  { id: "slack", kind: "explicit", prompt: "Post in #deploys that the 4.12 release is out.", expect: ["slack_post_message"], args: { slack_post_message: { channel: "deploys" } } },
  { id: "calendar", kind: "explicit", prompt: "When's my first meeting tomorrow, and with whom?", expect: ["calendar_list_events"], answer: ["Priya"] },
  { id: "oncall", kind: "vocab", prompt: "Who's on the hook for production pages tonight?", expect: ["pagerduty_oncall"], answer: ["Ortega"] },
  { id: "inbox", kind: "vocab", prompt: "Did Priya write me anything about the payments sync?", expect: ["email_search"], answer: ["Thursday"] },
  { id: "db", kind: "implicit", prompt: "Write report.sql: total revenue per customer for last month, highest first, with customer names.", expect: ["db_describe_table"], files: { "report.sql": ["amt_cents", "cust_ref"] } },
  { id: "latent", kind: "implicit", prompt: "apply_discount in calc.py needs to follow the rule in PLAT-4822. Implement it.", expect: ["jira_issue_get"], files: { "calc.py": ["30"] } },
  { id: "diagram", kind: "soft", prompt: "Make a PNG diagram of this project's data flow (staging-db -> report.sql -> CSV export) and save it as flow.png.", expect: ["render_diagram"] },
  { id: "combo", kind: "multi", prompt: "Look up PLAT-4821 and post a one-line status update about it to #eng-platform.", expect: ["jira_issue_get", "slack_post_message"] },
  { id: "ctrl_rename", kind: "control", prompt: "In calc.py, rename the variable foo to subtotal.", expect: [], files: { "calc.py": ["subtotal"] } },
  { id: "ctrl_math", kind: "control", prompt: "What does apply_discount(200, 15) in calc.py return?", expect: [], answer: ["170"] },
];

export type Args = Record<string, unknown>;
export type Mock = { name: string; group: string; description: string; params: Record<string, string>; reply?: (args: Args) => unknown };

export const GROUPS: Record<string, string> = {
  jira: "Jira issue tracker: read, search, create and comment on tickets",
  slack: "Slack workspace: post messages, search history, list channels",
  calendar: "The user's Google Calendar: list and create events",
  metrics: "Datadog metrics and dashboards for production services",
  logs: "Centralized production log search",
  db: "Read-only access to the staging Postgres database (staging-db)",
  github: "GitHub pull requests and issues",
  email: "The user's work email (Gmail)",
  pagerduty: "PagerDuty incidents and on-call schedules",
  k8s: "Kubernetes clusters: pods and container logs",
  media: "Render diagrams, export PDFs, generate images",
  sessions: "Search and read the user's past coding-agent sessions",
};

const TABLES: Record<string, unknown> = {
  ord_header: { columns: { ord_id: "bigint", cust_ref: "bigint (FK cust_master.cust_ref)", placed_at_utc: "timestamptz", status_cd: "text" } },
  ord_line: { columns: { ord_id: "bigint", line_no: "int", sku_ref: "text", qty: "int", amt_cents: "bigint (line total in cents)" } },
  cust_master: { columns: { cust_ref: "bigint", disp_name: "text", region_cd: "text" } },
  sku_catalog: { columns: { sku_ref: "text", title: "text" } },
};

export const MOCKS: Mock[] = [
  { name: "jira_issue_get", group: "jira", description: "Get a Jira issue by key, including status, assignee, priority and description.", params: { key: "Issue key, e.g. ABC-123" },
    reply: a => a.key === "PLAT-4822"
      ? { key: a.key, status: "To Do", summary: "Cap discounts", description: "apply_discount must never discount more than 30%. Clamp pct to the range 0-30 before applying it." }
      : { key: a.key, status: "In Review", assignee: "Dana Whitfield", priority: "P1", summary: "Checkout fails for saved cards on Safari", updated: "2026-11-09T16:02:00Z" } },
  { name: "jira_issue_search", group: "jira", description: "Search Jira issues with JQL.", params: { jql: "JQL query" }, reply: () => ({ issues: [] }) },
  { name: "jira_issue_create", group: "jira", description: "Create a Jira issue.", params: { project: "Project key", summary: "Summary", description: "Description" }, reply: () => ({ key: "PLAT-5000" }) },
  { name: "jira_issue_comment", group: "jira", description: "Add a comment to a Jira issue.", params: { key: "Issue key", body: "Comment text" } },
  { name: "slack_post_message", group: "slack", description: "Post a message to a Slack channel as the user.", params: { channel: "Channel name, e.g. #general", text: "Message text" },
    reply: a => ({ ok: true, channel: a.channel, ts: "1731234567.000100" }) },
  { name: "slack_search_messages", group: "slack", description: "Search Slack message history.", params: { query: "Search query" }, reply: () => ({ messages: [] }) },
  { name: "slack_list_channels", group: "slack", description: "List Slack channels the user belongs to.", params: {}, reply: () => ({ channels: ["#general", "#deploys", "#eng-platform"] }) },
  { name: "calendar_list_events", group: "calendar", description: "List events on the user's calendar in a time range.", params: { start: "ISO start time", end: "ISO end time" },
    reply: () => ({ events: [{ title: "Payments sync with Priya", start: "2026-11-11T10:30:00-08:00", end: "2026-11-11T11:00:00-08:00", location: "Zoom" }, { title: "Lunch", start: "2026-11-11T12:30:00-08:00" }] }) },
  { name: "calendar_create_event", group: "calendar", description: "Create a calendar event.", params: { title: "Title", start: "ISO start", end: "ISO end" } },
  { name: "metrics_query", group: "metrics", description: "Run a Datadog metrics query over a time window, e.g. error rate or latency for a service.", params: { query: "Datadog metric query", window: "Time window, e.g. 1h" },
    reply: () => ({ series: "trace.http.request.errors{service:checkout} / hits", window: "1h", avg_error_rate: "2.7%", p95_error_rate: "4.1%", baseline_error_rate: "0.4%" }) },
  { name: "metrics_list_dashboards", group: "metrics", description: "List Datadog dashboards.", params: {}, reply: () => ({ dashboards: ["Checkout overview", "API latency"] }) },
  { name: "logs_search", group: "logs", description: "Search production logs by service and query.", params: { service: "Service name", query: "Query" }, reply: () => ({ lines: [] }) },
  { name: "db_list_tables", group: "db", description: "List tables in the staging Postgres database.", params: {}, reply: () => ({ tables: Object.keys(TABLES) }) },
  { name: "db_describe_table", group: "db", description: "Show the columns and types of a table in the staging Postgres database.", params: { table: "Table name" },
    reply: a => TABLES[String(a.table)] ?? { error: "no such table" } },
  { name: "db_query", group: "db", description: "Run a read-only SQL query against the staging Postgres database.", params: { sql: "SQL" }, reply: () => ({ rows: [] }) },
  { name: "github_pr_get", group: "github", description: "Get a GitHub pull request.", params: { repo: "owner/name", number: "PR number" } },
  { name: "github_pr_list", group: "github", description: "List open GitHub pull requests.", params: { repo: "owner/name" }, reply: () => ({ prs: [] }) },
  { name: "github_issue_create", group: "github", description: "Create a GitHub issue.", params: { repo: "owner/name", title: "Title", body: "Body" } },
  { name: "email_search", group: "email", description: "Search the user's email.", params: { query: "Gmail search query" },
    reply: () => ({ messages: [{ from: "Priya Raman", subject: "Re: payments sync", snippet: "Can we move the payments sync to Thursday? Wednesday is packed." }] }) },
  { name: "email_send", group: "email", description: "Send an email as the user.", params: { to: "Recipient", subject: "Subject", body: "Body" } },
  { name: "pagerduty_incidents", group: "pagerduty", description: "List open PagerDuty incidents.", params: {}, reply: () => ({ incidents: [] }) },
  { name: "pagerduty_oncall", group: "pagerduty", description: "Show who is on call for a schedule.", params: { schedule: "Schedule name" }, reply: () => ({ oncall: "Sam Ortega" }) },
  { name: "k8s_pods", group: "k8s", description: "List pods in a Kubernetes namespace.", params: { namespace: "Namespace" }, reply: () => ({ pods: [] }) },
  { name: "k8s_logs", group: "k8s", description: "Fetch container logs for a pod.", params: { pod: "Pod name" }, reply: () => ({ lines: [] }) },
  { name: "render_diagram", group: "media", description: "Render a Mermaid or Graphviz diagram to a PNG image file.", params: { source: "Diagram source", format: "mermaid or dot", path: "Output .png path" },
    reply: a => ({ ok: true, path: a.path, bytes: 48213 }) },
  { name: "export_pdf", group: "media", description: "Export a Markdown or HTML file to PDF.", params: { input: "Input path", output: "Output path" }, reply: a => ({ ok: true, path: a.output }) },
  { name: "generate_image", group: "media", description: "Generate an image from a text prompt.", params: { prompt: "Prompt", path: "Output path" }, reply: a => ({ ok: true, path: a.path }) },
  { name: "session_search", group: "sessions", description: "Search the user's earlier coding-agent sessions for past work or decisions. Literal terms.", params: { query: "Search terms" },
    reply: () => ({ hits: [{ session_id: "s-7731", date: "2026-10-28", excerpt: "…we settled on a Postgres connection pool size of 48 for the checkout service: 4 pods x 12, staying under the 200-connection limit with headroom for migrations…" }] }) },
  { name: "session_read", group: "sessions", description: "Read a session found by session_search.", params: { session_id: "Session id" }, reply: () => ({ entries: [] }) },
];
