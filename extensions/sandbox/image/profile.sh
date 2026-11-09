# Login-shell PATH for Pi's sandbox: mise shims first, then Cargo and Go bins.
for dir in "${GOPATH:+$GOPATH/bin}" "${CARGO_HOME:+$CARGO_HOME/bin}" "${MISE_DATA_DIR:+$MISE_DATA_DIR/shims}"; do
  case "$dir" in
    "") ;;
    *) case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac ;;
  esac
done
export PATH
