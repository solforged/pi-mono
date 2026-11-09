# Assistant computer

Mac-first prototype of a persistent Linux computer for a personal assistant.
Pi runs inside the guest, alongside a browser and a shared XFCE desktop. This
milestone supplies the computer, not an autonomous assistant service.

## Start here

This prototype is separate from the host extensions. Use
`node ~/src/pi-mono/computer/cli.mjs` directly, or link the executable as
`assistant-computer` in a directory on `PATH` for the commands below. Supply the
host requirements separately; installing extensions does not create or start a VM.

```sh
assistant-computer doctor
assistant-computer create
assistant-computer start --wait
assistant-computer desktop --open
# In another terminal, obtain the VNC password without publishing it:
assistant-computer password
```

The desktop command keeps an SSH tunnel open; Ctrl-C closes it. On macOS,
`--open` launches Screen Sharing. Other hosts can connect a VNC viewer to
`vnc://127.0.0.1:15900`. The same desktop is used by applications and human
operators. Clipboard synchronization is disabled in x11vnc. The desktop password uses
legacy eight-character VNC authentication; the SSH tunnel supplies transport
encryption. Chromium's snap can select a basic password store when no desktop
keyring is available. Do not save account passwords in the prototype browser.

```sh
assistant-computer ssh
assistant-computer pi
assistant-computer status
assistant-computer logs
assistant-computer stop
```

Pi has no model credentials. Use `/login` inside guest Pi when deliberately
ready to give the guest access to a provider; host credentials and extensions
are never copied automatically. This grants access to that provider account,
not only to the currently requested task.

## Host requirements

- Node.js 22.19 or newer.
- QEMU and its UEFI firmware, OpenSSH, curl, and tar.
- macOS uses HVF and `hdiutil` to build the cloud-init seed.
- Linux uses KVM and `xorriso`; the user must have access to `/dev/kvm`.
- `age` for encrypted backup/restore; not needed to boot.

Install these tools through the host's package manager and configure KVM
permissions separately on Linux. No host service is installed or started by
extension setup. Do not treat passing controller tests as live VM acceptance.

Defaults: 4 CPUs, 8192 MiB RAM, a sparse 64 GiB disk, SSH on host loopback port
22222, and a foreground desktop tunnel on host loopback port 15900. Override
resources at creation, for example:

```sh
assistant-computer create --cpus 2 --memory 4096 --disk 32
```

Use `--state DIR` or `PI_COMPUTER_STATE` for another computer. State paths must
be short enough for a Unix socket and cannot contain commas or newlines.
Creation never overwrites an existing VM directory. Partial failed creations
are retained for inspection, not automatically deleted.

## Guest setup

Ubuntu 24.04 ARM64 on this Mac; the same recipe selects amd64 on an x86-64
Linux host. There is no automatic cross-architecture emulation.

Cloud-init installs:

- XFCE, Xvfb, x11vnc, a terminal, screenshot utility, Git, jq, and ripgrep.
- Chromium from Canonical's stable snap, with the normal browser sandbox.
- Node 22.22.0, verified against a checked-in official SHA256.
- Pi coding agent 1.0.2, installed without npm lifecycle scripts.

The downloaded Ubuntu image is verified using Canonical's checksum manifest
over HTTPS. Its URL and checksum are recorded in `vm/config.json`; a rotating
image between download requests causes creation to fail. This is not detached
GPG signature verification. The recipe is repeatable configuration, not a
bit-for-bit reproducible build: apt, Chromium, and npm transitive dependencies
can change.

Guest root owns `/opt/assistant-computer/provision.sh` and the systemd units.
The script is idempotent and writes `/var/log/assistant-provision.log`; it
publishes `/var/lib/assistant-computer/ready` only after its checks succeed.
`start --wait` waits up to 30 minutes. The first boot requires network access.
Failures leave the VM running for inspection:

```sh
assistant-computer ssh 'sudo cloud-init status --long'
assistant-computer ssh 'sudo tail -n 80 /var/log/assistant-provision.log'
assistant-computer ssh 'sudo journalctl -u assistant-desktop -u assistant-vnc --no-pager -n 40'
# After correcting a failed bootstrap:
assistant-computer ssh 'sudo bash /opt/assistant-computer/provision.sh'
```

Changing the source recipe does not automatically update an existing guest;
the cloud-init seed is generated at creation. Deliberately copy and install
updated scripts or create a new guest to test provisioning changes.

## Files and recovery

Private state defaults to `~/.local/state/pi-computer/`:

```text
vm/
  config.json            native architecture, resources, image receipt
  disk.qcow2             installed apps and guest data
  firmware-vars.fd       persistent UEFI variables
  seed.iso, seed/        first-boot configuration; contains guest credentials
  id_ed25519*            dedicated host-to-guest login identity
  guest-host-key*        guest host identity pinned before first connection
  known_hosts            pinned identity, not trust-on-first-use
  vnc-password           desktop access password
  serial.log             boot and provisioning diagnostics
  qmp.sock, qemu.pid      runtime control
operation.lock/          owner metadata while mutating lifecycle/state
```

The controller never signals a process merely because its PID is in a file.
QMP provides status and shutdown. Missing QMP with a live PID refuses disk
operations; protocol errors and timeouts do not mean the VM is stopped. A
stale operation lock must be inspected before manual removal.

`stop` requests ACPI shutdown and waits up to a minute. `stop --force` requests
QEMU power-off and can lose guest data. There is no host login autostart yet.

Explicit file transfer is confined to simple paths under the guest workspace:

```sh
assistant-computer put ./document.pdf /home/assistant/workspace/document.pdf
assistant-computer get /home/assistant/workspace/document.pdf ./reviewed.pdf
```

Full VM backups require a stopped VM and an age public recipient:

```sh
assistant-computer stop
assistant-computer backup ~/Backups/assistant.tar.age --recipient age1YOUR_PUBLIC_RECIPIENT
assistant-computer --state ~/.local/state/pi-computer-restored \
  restore ~/Backups/assistant.tar.age --identity /path/to/age-identity.txt
```

Restore accepts only the expected regular files, validates the configuration
and qcow2 disk, and publishes a complete restored VM into an empty state
location. It never overwrites an existing VM. The recipient's private identity
is used by the host age process, never copied into the guest.

Encrypted full-disk restore is **same-architecture only**. QEMU UEFI code is
resolved from the receiving host; retain a compatible QEMU/firmware version
when moving an existing disk. For Amarna, provision a native guest and transfer
selected application data. Browser sessions can require reauthentication.
Do not run two copies of an assistant with the same external jobs/accounts.

Backup temporarily makes a compacted plaintext disk and tar inside the private
state directory; budget extra disk space. Normal cleanup removes these. A
crash can leave staging data and a lock: inspect and remove only stale staging
and locks. File modes are not encryption; rely on host disk encryption too.

## Security boundary

- No host filesystem mounts, host SSH agent, host Pi auth, or host environment
  variables are injected into the guest.
- Host SSH listens only through QEMU's loopback port forward. Desktop VNC binds
  guest loopback and is reached only through a foreground SSH tunnel.
- SSH uses a dedicated key, ignores host SSH configuration/agents, and requires
  the pre-generated guest host key.
- The assistant has passwordless sudo **inside the guest**, so it can install
  applications and can also damage or compromise its own computer.
- Guest outbound networking is unrestricted. QEMU user networking can reach
  the LAN and host services, including its special host gateway. This is **not
  a host/LAN network isolation boundary**. Add host-enforced egress policy
  before unattended use with untrusted content or sensitive services.
- Anything logged into this browser is within the assistant's authority.
  A VM does not enforce email/purchase approvals. There are no such gates yet.
- Browser automation, GUI-control tools, connectors, memory, remote APIs, and
  unattended background jobs are not implemented in this milestone.

## Assistant runtime decision

Use [Pi Durable](https://earendil.com/posts/pi-durable/) for the next layer,
not a homegrown scheduler wrapped around terminal Pi. Its durable conversations,
tasks, application documents, replay policies, and background work fit this
assistant. Keep VM lifecycle separate from harness lifecycle.

Start that integration with the harness inside the guest and persistent storage
there. A host-side controller remains narrow. Do not give a host-resident
`NodeExecutionEnv` to an agent intended to operate only inside the VM.

Pin the experimental package version and test recovery before adopting it.
The [Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
documents a different extension API; `pi-sol` coding-agent extensions are not
assumed compatible. Request deduplication is not exactly-once external side
effects. Browser writes must not be marked replay-safe just because the task
can resume. Pi Durable's SQLite default survives process crashes but does not
promise preservation of the newest commits after power failure.

## Checks

```sh
node --test computer/tests/*.test.mjs
for script in computer/guest/*.sh; do bash -n "$script" || exit; done
node computer/cli.mjs doctor
# Explicit live test: restarts the guest and leaves it running.
node computer/tests/live-smoke.mjs
```

The tests make no model calls. The encrypted backup integration test uses local
age and qemu-img when installed; otherwise it reports a skip. Live acceptance:
boot, wait for readiness, verify Pi as the assistant user, open Chromium on the
shared display, transfer a file, stop and restart, and verify persistence.
