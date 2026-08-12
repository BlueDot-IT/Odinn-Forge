import { createBuiltInRegistry } from "./index.ts";
import { installTaskWorker } from "./task-worker-host.ts";

installTaskWorker(createBuiltInRegistry);
