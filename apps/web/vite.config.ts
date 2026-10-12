import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4000";
const proxy = {
	"/api/health": {
		target,
		rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, ""),
	},
	"/api": { target },
};

export default defineConfig({
	plugins: [react()],
	server: { proxy },
	preview: { proxy },
});
