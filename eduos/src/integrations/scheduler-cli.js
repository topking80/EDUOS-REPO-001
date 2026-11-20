import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, assertSafeRuntimeRole, assertSchemaReady } from "../db.js";
import { dispatchScheduledSisSync } from "./scheduler.js";

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  (async()=>{
    await assertSafeRuntimeRole();
    await assertSchemaReady();
    const result=await dispatchScheduledSisSync({db:pool});
    console.log(JSON.stringify(result));
  })().catch(async error=>{console.error(`SIS scheduled sync failed: ${error.message}`);process.exitCode=1;})
    .finally(()=>pool.end());
}
