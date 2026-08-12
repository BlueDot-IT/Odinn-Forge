import { createBuiltInRegistry } from "./index.ts";
import { installBrowserWorker } from "./browser-worker-host.ts";

installBrowserWorker(createBuiltInRegistry);
