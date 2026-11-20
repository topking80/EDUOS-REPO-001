import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { dispatchScheduledSisSync } from "./scheduler.js";

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  dispatchScheduledSisSync({db:pool})
    .then(result=>{console.log(JSON.stringify(result));return pool.end();})
    .catch(async error=>{console.error(`SIS scheduled sync failed: ${error.message}`);await pool.end();process.exit(1);});
}
