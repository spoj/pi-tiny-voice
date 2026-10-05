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
- The voice model answers small talk itself and hands real requests to Pi as user messages, in your words rather than the voice's. Once the voice hands something over, the page waits until you have been quiet for 5 seconds, then sends what you said since you were last quiet that long in a `<voice_request>` tag, preceded by the rest of the call since the last handoff in a `<voice_context>` tag. If Pi is busy, they steer the running task.
- So a pause shorter than the wait never splits a request, however the voice chops it up. What you say that the voice doesn't hand over before you go quiet is small talk: Pi sees it in the next `<voice_context>`. When the voice hands over again with nothing new from you, as it does while it waits on a slow answer, Pi gets nothing; its answer just goes to the latest handoff.
- The voice model hears only the conversation, never tool calls or results. It speaks Pi's answers. It also knows about Pi's progress updates and anything you type in Pi, but does not read them out.
- The voice model starts with the last 6,000 characters of the conversation in Pi.
- The server listens on `127.0.0.1` only, and each address carries a random token. Tailscale access comes from a foreground `tailscale serve`, which stops with the server.

## Caveats

- The ChatGPT realtime endpoint is private and could change without notice.
- Only the most recently opened page follows Pi; opening the address elsewhere ends the earlier page and its call. Switching Pi sessions ends both.
