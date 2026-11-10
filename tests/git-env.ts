// Preloaded with --import before every test file. Git hooks and `git rebase
// --exec` export variables that point Git at a repository, and those beat a
// command's cwd or -C. Left in place, fixture repositories would take their
// `git config` and commits into the repository that ran the tests. Config
// variables (GIT_CONFIG_COUNT and the like) stay, since the sandbox's signing
// policy lives in them.
for (const name of [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE",
  "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE",
]) delete process.env[name];
