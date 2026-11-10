import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import voice from "../index.ts";

test("serves the page under its token only, with a policy that keeps transcript markdown from running script or loading images", async (t) => {
	// Without tailscale on PATH the address is the local one.
	const path = process.env.PATH;
	process.env.PATH = "";
	t.after(() => { process.env.PATH = path; });

	let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let url = "";
	voice({ on() {}, registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; } } as unknown as ExtensionAPI);
	const ctx = {
		ui: { setStatus() {}, notify: (message: string) => { url = message.replace("Voice: ", ""); }, theme: { colors: {}, appearance: "dark" } },
	} as unknown as ExtensionCommandContext;
	await command("", ctx);
	t.after(() => command("off", ctx));

	const page = await fetch(url);
	const policy = page.headers.get("content-security-policy")!;
	const nonce = /script-src 'nonce-([\w-]+)';/.exec(policy)![1];
	assert.equal(policy, `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'`);
	assert.ok((await page.text()).includes(`<script nonce="${nonce}">`));
	assert.equal((await fetch(url.replace(/[^/]+\/$/, "wrong/"))).status, 404);
});
