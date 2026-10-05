# pi-tiny-voice

Talk to [Pi](https://github.com/earendil-works/pi) from any browser. A realtime voice model listens and speaks; Pi, on whatever model it is set to, does the work.

## Usage

```text
/voice       start, or show the address again
/voice off   stop
```

Open the printed address and press Start. The page shows the conversation in Pi and follows it live. As in [pi-tiny-tools](https://github.com/spoj/pi-tiny-tools), thinking, tool calls and extension messages shrink to colored names; tap one to see it in full, drawn much as the terminal draws it. With [Tailscale](https://tailscale.com), the address is an HTTPS link that any device on your tailnet can open; without it, open the local address on the same machine.

## How it works

- The browser handles audio: microphone, echo cancellation and playback. It connects directly to ChatGPT's realtime voice (`gpt-live-1-codex`) over WebRTC.
- Pi starts the call with your `openai-codex` login, so usage counts against your ChatGPT plan. The login never reaches the browser.
- The voice model answers small talk itself and hands real requests to Pi as user messages, in your words rather than the voice's: everything you said since the last handoff in a `<voice_request>` tag, preceded by what the voice said in a `<voice_context>` tag. If Pi is busy, they steer the running task.
- The voice model, not a timer, decides when a request goes to Pi: each handoff is sent the moment the voice makes it, with your words so far. It often hands over while you are still talking; the rest of that turn follows as another message when the voice ends your turn by starting to speak, and anything you add later goes with the next handoff. Every word you say reaches Pi once. When the voice hands over again with nothing new from you, as it does while it waits on a slow answer, Pi gets nothing; its answer just goes to the latest handoff.
- The voice model is told to keep listening while you pause to think and to use backchannels sparingly. After each handoff it says so in a few words once you have finished (`ack_filler` is off; this is prompted), which also ends your turn, then stays quiet while Pi works: no reassuring or checking in.
- The voice model hears only the conversation, never tool calls or results. It speaks Pi's answers. It also knows about Pi's progress updates and anything you type in Pi, but does not read them out.
- The voice model starts with the last 6,000 characters of the conversation in Pi.
- The server listens on `127.0.0.1` only, and each address carries a random token. Tailscale access comes from a foreground `tailscale serve`, which stops with the server.

## Caveats

- The ChatGPT realtime endpoint is private and could change without notice.
- Only the most recently opened page follows Pi; opening the address elsewhere ends the earlier page and its call. Switching Pi sessions ends both.
