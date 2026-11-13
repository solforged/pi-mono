# Voice dictation

Hold `ctrl+space`, speak, and release: the words appear in the editor at the
cursor, for you to review and send. Nothing is submitted for you. A tap
instead of a hold keeps listening until you tap again or press Enter; Escape
discards the recording.

While recording, a line above the editor shows a level meter, the time, and a
live transcript that refreshes as you speak. Speak after the red dot appears:
the microphone takes about 0.2 s to open. The preview is made from the last
30 seconds only, which keeps it quick in a long recording; the text inserted
at the end is always of the whole recording.

## Requirements

- macOS on Apple silicon with `modules.voice.enable = true` in the system
  flake (`~/src/system`). It installs ffmpeg and runs the local speech server
  as the `org.nixos.voice-stt` launch agent, which keeps Parakeet loaded for
  every session and transcribes a five-second clip in about 50 ms. `/voice`
  checks that it is reachable; its log is `~/Library/Logs/voice-stt.log`. The
  server, its vocabulary fixes and `voice-bench` live in `config/voice/` there.
- ffmpeg is found on `PATH` or in the Nix profiles, for a Pi started without
  them. The terminal running Pi needs microphone permission; macOS asks on
  first use.
- For hold-to-talk, a terminal that reports key releases through the Kitty
  keyboard protocol: Rex, Ghostty, kitty or WezTerm. Elsewhere the key
  toggles recording.

## Settings

In `~/.pi/agent/settings.json`:

```json
{ "voice": { "key": "ctrl+space", "url": "http://127.0.0.1:8178" } }
```

`key` takes Pi's key ids, such as `super+ctrl+x`. Pick one the terminal passes
through: macOS takes `ctrl+space` for switching input sources unless that
shortcut is off in Keyboard settings.

## Behaviour

- Letting go of the modifier before the key still ends recording, and the
  key's repeats are swallowed rather than typed.
- Enter while recording finishes it like a release. Enter while the final
  transcript is on its way is ignored, so it cannot send the prompt without
  the dictated words.
- Clips under 0.3 s are dropped as accidental presses; clips whose loudest
  moment stays below about -46 dBFS are reported as silence instead of sent.
- Recording stops at two minutes. Transcripts over 1000 characters are appended
  to the editor rather than pasted, which Pi would fold into a `[paste #n]`
  marker.
