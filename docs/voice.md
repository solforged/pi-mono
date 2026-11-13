# Voice dictation

Hold `ctrl+space`, speak, and release: the words appear in the editor at the
cursor, for you to review and send. Nothing is submitted for you. A tap
instead of a hold keeps listening until you tap again or press Enter; Escape
discards the recording.

While recording, a line above the editor shows a level meter, the time, and a
live transcript that refreshes as you speak. Speak after the red dot appears:
the microphone takes about 0.2 s to open.

## Requirements

- macOS, with ffmpeg on `PATH` or in Homebrew's prefix. The terminal running
  Pi needs microphone permission; macOS asks on first use.
- The local speech server from the dotfiles' `voice` module, which keeps
  Parakeet loaded for every session and transcribes a five-second clip in
  about 50 ms. `/voice` checks that it is reachable. Its vocabulary fixes and
  `voice:bench` comparison live with it, in `desktop/voice/` of the dotfiles.
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
