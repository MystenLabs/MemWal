// BotId is Vercel-only — skip on Railway/other platforms
if (typeof process !== "undefined" && process.env?.VERCEL) {
  const { initBotId } = require("botid/client/core");
  initBotId({
    protect: [
      {
        path: "/api/chat",
        method: "POST",
      },
    ],
  });
}
