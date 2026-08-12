import { installBrowserWorker } from "@odinn/kernel/browser-worker-host";
import { createRuntimeRegistry } from "./index.ts";

installBrowserWorker(createRuntimeRegistry);
