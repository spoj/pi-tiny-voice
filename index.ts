import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { colorToHex, Marked } from "@earendil-works/pi-tui";

const CALLS = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const INSTRUCTIONS = `You are the voice of pi, a coding agent working on the user's computer. You speak with the user; pi does the work. You cannot run tools, read files or browse yourself.

Delegate anything that needs tools, files, the web, or careful reasoning about the user's work. Never claim work is done before pi reports it. Pass corrections and additions to running work on immediately. Handle greetings, small talk and questions already answered in the conversation yourself.

Pi's messages are authoritative; present them as your own work. Speak briefly and naturally: lead with the outcome, and don't read out code, paths, tables or long lists unless asked.`;
const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");

type Content = string | { type: string; text?: string; data?: string; mimeType?: string }[];
const text = (content: Content) =>
	typeof content === "string"
		? content
		: content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();

const esc = (value: unknown) => String(value).replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
const marked = new Marked({ renderer: { html: ({ text, block }) => (block ? `<p>${esc(text.trim())}</p>` : esc(text)) } });
const md = (source: string) => marked.parse(source) as string;
const images = (content: Content) =>
	typeof content === "string"
		? ""
		: content
				.filter((part) => part.type === "image")
				.map((part) => `<img src="data:${part.mimeType};base64,${part.data}">`)
				.join("");

// Like pi's terminal: `keep` lines from the start, or from the end when negative; the rest expand on tap.
function fold(body: string, keep: number) {
	const all = esc(body).split("\n");
	if (all.length <= Math.abs(keep)) return `<div class="out">${all.join("\n")}</div>`;
	const tail = keep < 0;
	const shown = (tail ? all.slice(keep) : all.slice(0, keep)).join("\n");
	const rest = (tail ? all.slice(0, keep) : all.slice(keep)).join("\n");
	const more = `<details><summary>... (${all.length - Math.abs(keep)} ${tail ? "earlier" : "more"} lines)</summary>${rest}</details>`;
	return `<div class="out">${tail ? more + shown : shown + more}</div>`;
}

// Like pi-tiny-tools: thinking, tools and extension messages shrink to a colored name; tapping it shows the block.
const trace = (name: string, block: string) => `<span class="trace"><b>${esc(name)}</b>${block}<wbr></span>`;

function tool(id: string, name: string, args: Record<string, unknown>, failed: boolean) {
	let title = `<b>${esc(name)}</b>`;
	if (name === "bash") title = `<b>$ ${esc(args.command)}</b>`;
	else if (name === "read" || name === "edit" || name === "write") {
		const path = String(args.path);
		title += ` <span class="accent">${esc(path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)}</span>`;
	} else {
		const pairs = Object.entries(args)
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join(" ");
		title += ` <span class="muted">${esc(pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs)}</span>`;
	}
	const preview = name === "write" ? fold(String(args.content), 10) : "";
	return trace(name, `<div class="tool${failed ? " error" : ""}" id="${esc(id)}">${title}${preview}</div>`);
}

// The page shows pi's transcript the way its terminal does; a tool result fills in its call's box.
function render(message: AgentMessage): { html: string; into?: string; status?: string } | undefined {
	switch (message.role) {
		case "user":
			return { html: `<div class="user">${md(text(message.content))}${images(message.content)}</div>` };
		case "assistant": {
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			const parts = message.content.map((part) => {
				if (part.type === "toolCall") return tool(part.id, part.name, part.arguments, failed);
				if (part.type === "text" && part.text.trim()) return `<div class="md">${md(part.text)}</div>`;
				if (part.type === "thinking" && part.thinking.trim())
					return trace("think", `<div class="thinking">${md(part.thinking)}</div>`);
				return "";
			});
			if (message.stopReason === "aborted") parts.push(`<div class="error">Operation aborted</div>`);
			if (message.stopReason === "error") parts.push(`<div class="error">Error: ${esc(message.errorMessage)}</div>`);
			return { html: parts.join("") };
		}
		case "toolResult": {
			const name = message.toolName;
			const diff = (message.details as { diff?: string } | undefined)?.diff;
			const output = name === "write" && !message.isError ? "" : text(message.content);
			let body = output && fold(output, name === "bash" ? -5 : name === "read" && !message.isError ? 0 : 10);
			if (diff) {
				const colored = diff
					.split("\n")
					.map((line) => `<span class="${line[0] === "+" ? "add" : line[0] === "-" ? "del" : ""}">${esc(line)}</span>`);
				body = `<div class="out">${colored.join("\n")}</div>`;
			}
			return { html: body + images(message.content), into: message.toolCallId, status: message.isError ? "error" : "success" };
		}
		case "custom":
			return message.display
				? { html: trace(message.customType, `<div class="custom">${md(text(message.content))}</div>`) }
				: undefined;
		case "compactionSummary":
			return { html: trace("compaction", `<div class="custom">${md(message.summary)}</div>`) };
	}
}

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionCommandContext;
	let server: Server | undefined;
	let tunnel: ChildProcess | undefined;
	let stream: ServerResponse | undefined;
	let token = "";
	let url = "";
	let delegation: string | undefined;

	function send(event: string, data: unknown) {
		stream?.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	}

	function show(message: AgentMessage) {
		const fragment = render(message);
		if (fragment) send("show", fragment);
	}

	// The realtime API rejects context appends over 500 tokens; 125 code points stay under 500 bytes.
	function append(channel: "speakable" | "commentary", body: string, target?: string) {
		const events = (body.match(/[\s\S]{1,125}/gu) ?? []).map((chunk) => ({
			type: target ? "delegation.context.append" : "session.context.append",
			delegation_item_id: target,
			channel,
			content: [{ type: "input_text", text: chunk }],
		}));
		send("voice", events);
	}

	function history() {
		const lines = ctx.sessionManager.getBranch().flatMap((entry) => {
			if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
			const said = text(entry.message.content);
			return said ? [`${entry.message.role === "user" ? "User" : "Pi"}: ${said}`] : [];
		});
		return lines.join("\n\n").slice(-6000);
	}

	async function call(sdp: string) {
		const key = (await ctx.modelRegistry.getApiKeyForProvider("openai-codex"))!;
		const claims = JSON.parse(Buffer.from(key.split(".")[1]!, "base64url").toString());
		const recent = history();
		return fetch(CALLS, {
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"chatgpt-account-id": claims["https://api.openai.com/auth"].chatgpt_account_id,
				originator: "pi",
				"x-session-id": ctx.sessionManager.getSessionId(),
				"openai-alpha": "quicksilver=v2",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				sdp,
				session: {
					model: "gpt-live-1-codex",
					instructions: recent ? `${INSTRUCTIONS}\n\nRecent conversation in pi:\n\n${recent}` : INSTRUCTIONS,
					audio: { output: { voice: "sol" } },
					delegation: { type: "client", ack_filler: true },
				},
			}),
		});
	}

	async function handle(req: IncomingMessage, res: ServerResponse) {
		const [, key, route] = req.url!.split("/");
		if (key !== token) return res.writeHead(404).end();
		let body = "";
		for await (const chunk of req) body += chunk;
		if (route === "") {
			const { colors, appearance } = ctx.ui.theme;
			const theme = Object.entries(colors).map(([name, color]) => `--${name}:${colorToHex(color)};`).join("");
			return res
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(page.replace("/*theme*/", `${theme}color-scheme:${appearance};`));
		}
		if (route === "call") {
			const answer = await call(body);
			return res.writeHead(answer.status).end(await answer.text());
		}
		if (route === "delegate") {
			const { id, request, turns } = JSON.parse(body);
			// A handoff without a request repeats one pi is working on; pi answers the newest handoff.
			delegation = id;
			if (!request) return res.end();
			const context = turns.length ? `<voice_context>\n${turns.join("\n")}\n</voice_context>\n` : "";
			pi.sendUserMessage(`${context}<voice_request>\n${request}\n</voice_request>`, { deliverAs: "steer" });
			return res.end();
		}
		if (route === "events") {
			stream?.end("event: end\ndata: bye\n\n");
			stream = res;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			for (const message of ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)) show(message);
			send("busy", !ctx.isIdle());
			ctx.ui.setStatus("voice", "🎙 live");
			res.on("close", () => {
				if (stream !== res) return;
				stream = undefined;
				ctx.ui.setStatus("voice", "🎙 ready");
			});
			return;
		}
		res.writeHead(404).end();
	}

	async function start() {
		token = randomBytes(12).toString("base64url");
		const http = createServer((req, res) =>
			handle(req, res).catch((error) => {
				res.statusCode = 500;
				res.end(String(error));
			}),
		);
		server = http;
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const { port } = http.address() as AddressInfo;
		const local = `http://127.0.0.1:${port}/`;
		const base = await new Promise<string>((resolve) => {
			tunnel = spawn("tailscale", ["serve", `--https=${port}`, local]);
			tunnel.stdout!.on("data", (data) => {
				const served = new RegExp(`https://\\S+:${port}/`).exec(String(data));
				if (served) resolve(served[0]);
			});
			tunnel.on("error", () => resolve(local));
			tunnel.on("exit", () => resolve(local));
		});
		url = `${base}${token}/`;
		ctx.ui.setStatus("voice", "🎙 ready");
	}

	function stop() {
		if (!server) return;
		stream?.end("event: end\ndata: bye\n\n");
		tunnel?.kill();
		server.close();
		server = tunnel = stream = undefined;
	}

	pi.on("input", (event) => {
		if (event.source !== "extension") append("commentary", `The user typed to pi: ${event.text}`);
	});

	pi.on("message_end", ({ message }) => {
		if (!stream) return;
		show(message);
		if (message.role !== "assistant") return;
		const said = text(message.content) || message.errorMessage;
		// Progress updates go to commentary: on speakable, the voice takes them for answers.
		if (said) append(message.stopReason === "toolUse" ? "commentary" : "speakable", said, delegation);
	});

	pi.on("agent_start", () => send("busy", true));

	pi.on("agent_settled", () => {
		send("busy", false);
		delegation = undefined;
	});

	pi.on("session_shutdown", stop);

	pi.registerCommand("voice", {
		description: "Talk to pi from a browser (/voice off to stop)",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			if (args.trim() === "off") {
				stop();
				return ctx.ui.setStatus("voice", undefined);
			}
			if (!server) await start();
			ctx.ui.notify(`Voice: ${url}`, "info");
		},
	});
}
