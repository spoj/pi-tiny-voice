# pi-tiny-voice

Talk to [Pi](https://github.com/earendil-works/pi) from any browser. A realtime voice model listens and speaks; Pi, on whatever model it is set to, does the work.

## Usage

```text
/voice       start, or show the address again
/voice off   stop
```

Open the printed address and press Start. With [Tailscale](https://tailscale.com), the address is an HTTPS link that any device on your tailnet can open; without it, open the local address on the same machine.

## How it works

- The browser handles audio: microphone, echo cancellation and playback. It connects directly to ChatGPT's realtime voice (`gpt-live-1-codex`) over WebRTC.
- Pi starts the call with your `openai-codex` login, so usage counts against your ChatGPT plan. The login never reaches the browser.
- The voice model answers small talk itself and hands real requests to Pi as user messages: the request in a `<voice_request>` tag, preceded by the call transcript since the last handoff in a `<voice_context>` tag. If Pi is busy, they steer the running task.
- Pi's text and final reply are spoken back. Its tool calls, and anything you type in Pi, are passed to the voice model without being read out.
- The voice model starts with the last 6,000 characters of the conversation in Pi.
- The server listens on `127.0.0.1` only, and each address carries a random token. Tailscale access comes from a foreground `tailscale serve`, which stops with the server.

## Caveats

- The ChatGPT realtime endpoint is private and could change without notice.
- Only the most recently started call hears Pi's replies. Switching Pi sessions ends the call.
