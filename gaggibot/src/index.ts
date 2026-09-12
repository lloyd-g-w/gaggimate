import http from "node:http";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { DiscordBot } from "./discordBot.js";
import { logger } from "./logger.js";
import { createApp } from "./server.js";

const cfg=loadConfig();
const log=logger(cfg.LOG_LEVEL);
const store=new Store(cfg.DATA_DIR);
const bot=new DiscordBot(cfg,store,log);
const server=http.createServer(createApp(cfg,store,bot,log));
server.listen(cfg.PORT,"0.0.0.0",()=>log.info("HTTP server listening",{port:cfg.PORT,dryRun:cfg.dryRun}));
void bot.start().catch(error=>{log.error("Discord login failed",{error:error instanceof Error?error.message:"unknown"}); process.exitCode=1; void shutdown();});
let stopping=false;
async function shutdown():Promise<void>{
  if(stopping)return; stopping=true; log.info("Shutting down");
  const forced=setTimeout(()=>process.exit(1),10_000); forced.unref();
  await bot.stop();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  store.close(); clearTimeout(forced); process.exit();
}
process.on("SIGTERM",()=>void shutdown()); process.on("SIGINT",()=>void shutdown());
process.on("unhandledRejection",reason=>log.error("Unhandled rejection",{error:reason instanceof Error?reason.message:"unknown"}));
