# Node 26 for the extensions and checks, plus the `pm-*` commands. Outside an
# activated shell, run them as `direnv exec . pm-test`; `devenv shell --`
# unsets TMPDIR, which moves Pi's IPC directory away from the diff handler's.
{
  pkgs,
  lib,
  options,
  ...
}:

let
  # Run from the checkout that contains the working directory, as mise did,
  # rather than $DEVENV_ROOT: a shell or agent that inherited this environment
  # from another checkout must still test the one it is in.
  root = name: ''
    root=$PWD
    until [ -f "$root/devenv.nix" ] && [ -d "$root/extensions" ]; do
      if [ "$root" = / ]; then
        echo "${name}: run inside a pi-mono checkout" >&2
        exit 1
      fi
      root=$(dirname "$root")
    done
    cd "$root"
  '';
  script = name: description: run: {
    inherit description;
    exec = root name + run;
  };
in
{
  # Pi sessions started here pass this environment to every command an agent
  # runs, in any repository: keep Nix's compiler, Apple SDK and xcrun shim out,
  # so builds elsewhere still use the host's compiler and Xcode.
  stdenv = pkgs.stdenvNoCC;
  apple.sdk = null;
  unsetEnvVars = options.unsetEnvVars.default ++ [
    "SOURCE_DATE_EPOCH"
    "MACOSX_DEPLOYMENT_TARGET"
    "ZERO_AR_DATE"
  ];

  packages = [ pkgs.nodejs_26 ];

  scripts = lib.mapAttrs (name: args: script name args.description args.run) {
    pm-install = {
      description = "Link every extension and roles.json into the Pi agent directory";
      run = ''exec node scripts/install.ts "$@"'';
    };
    pm-test = {
      description = "Test locally owned pi extensions without model calls";
      run = ''exec node --test --import ./tests/git-env.ts tests/*.test.ts "$@"'';
    };
    pm-computer-test = {
      description = "Test the assistant VM controller without model calls";
      run = ''exec node --test computer/tests/*.test.mjs "$@"'';
    };
    pm-profile = {
      description = "Profile saved Pi sessions: cost, carried context, cache rewrites, candidate sizing";
      run = ''exec node scripts/profile.ts "$@"'';
    };
    pm-faults = {
      description = "Run scripted provider faults through the installed Pi, without model calls";
      run = ''exec node tests/fixtures/fault-smoke.ts "$@"'';
    };
    pm-compaction-smoke = {
      description = "Time compaction in the installed Pi with and without the compaction extension, and fail if its summary is not used; no model calls";
      run = ''exec node tests/fixtures/compaction-smoke.ts "$@"'';
    };
    pm-sandbox-smoke = {
      description = "Exercise the tool sandbox against live Apple containers, without model calls";
      run = ''
        exec pi --offline --no-extensions --no-skills --no-context-files --no-prompt-templates --no-session \
          -e ./tests/fixtures/sandbox-smoke.ts -e ./tests/fixtures/no-model.ts \
          --provider no-model --model no-model/none -p /sandbox-smoke
      '';
    };
    pm-paired = {
      description = "PAID: run past fixes with and without an extension and compare cost, turns and test results";
      run = ''exec node scripts/paired.ts "$@"'';
    };
    pm-deferred-tools-eval = {
      description = "PAID: check that each preset model finds deferred tools through tool_search, with and without the prompt list";
      run = ''exec node scripts/deferred-tools-eval.ts "$@"'';
    };
  };
}
