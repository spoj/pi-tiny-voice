import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const CALLS = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const INSTRUCTIONS = `You are the voice of pi, a coding agent working on the user's computer. You speak with the user; pi does the work. You cannot run tools, read files or browse yourself.

Delegate anything that needs tools, files, the web, or careful reasoning about the user's work. Never claim work is done before pi reports it. Pass corrections and additions to running work on immediately. Handle greetings, small talk and questions already answered in the conversation yourself.

Pi's messages are authoritative; present them as your own work. Speak briefly and naturally: lead with the outcome, and don't read out code, paths, tables or long lists unless asked.`;
const page = readFileSync(new URL("./page.html", import.meta.url));

type Content = string | { type: string; text?: string }[];
const text = (content: Content) =>
	typeof content === "string"
		? content
		: content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();

export default function (pi: ExtensionAPI) {
	let ctx: ExtensionCommandContext;
	let server: Server | undefined;
	let tunnel: ChildProcess | undefined;
	let stream: ServerResponse | undefined;
	let token = "";
	let url = "";
	let delegation: string | undefined;
	let reply: string | undefined;

	// The realtime API rejects context appends over 500 tokens; 125 code points stay under 500 bytes.
	function append(channel: "speakable" | "commentary", body: string, target?: string) {
		const events = (body.match(/[\s\S]{1,125}/gu) ?? []).map((chunk) => ({
			type: target ? "delegation.context.append" : "session.context.append",
			delegation_item_id: target,
			channel,
			content: [{ type: "input_text", text: chunk }],
		}));
		stream?.write(`data: ${JSON.stringify(events)}\n\n`);
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
		if (route === "") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
		if (route === "call") {
			const answer = await call(body);
			return res.writeHead(answer.status).end(await answer.text());
		}
		if (route === "delegate") {
			const { item } = JSON.parse(body);
			delegation = item.id;
			pi.sendUserMessage(item.content.map((part: { text: string }) => part.text).join(""), { deliverAs: "steer" });
			return res.end();
		}
		if (route === "events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.flushHeaders();
			stream = res;
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
		if (message.role !== "assistant") return;
		const said = text(message.content) || message.errorMessage || "";
		const calls = message.content.filter((part) => part.type === "toolCall");
		if (!calls.length) return void (reply = said);
		if (said) append("speakable", said);
		append("commentary", calls.map((part) => `pi is running ${part.name} ${JSON.stringify(part.arguments)}`.slice(0, 300)).join("\n"));
	});

	pi.on("agent_settled", () => {
		if (reply) append("speakable", reply, delegation);
		reply = delegation = undefined;
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
