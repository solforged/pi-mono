// Give a piped standalone viewer a terminal size. SIGWINCH simulates Rex
// briefly halving the pane, then restoring it before the resize debounce fires.
Object.assign(process.stdout, { columns: 80, rows: 24 });
process.on("SIGWINCH", () => {
  const columns = process.stdout.columns;
  process.stdout.columns = Math.floor(columns / 2);
  process.stdout.emit("resize");
  process.stdout.columns = columns;
  process.stdout.emit("resize");
});
